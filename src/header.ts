/**
 * OFX header parsing.
 *
 * Handles the OFX 1.x SGML key:value header block (`OFXHEADER:100` …) and the
 * OFX 2.x `<?OFX … ?>` processing instruction (plus the XML prolog that
 * follows it). Real-world exports violate every corner of the format, so the
 * parser is tolerant by design: leading whitespace and NUL bytes are skipped,
 * keys may have any case, header blocks may be concatenated on one line, the
 * blank line before the body may be missing, processing instructions may be
 * unterminated, and a missing or entirely unrecognized header is reported as
 * a warning (or, in strict mode, throws).
 */
import { OfxParseError } from './errors.js';
import { offsetToLineColumn } from './text.js';
import type { ParseWarning } from './types.js';

/** Warning codes emitted by this module. */
export type HeaderWarningCode = 'missing-header' | 'header-unterminated';

/** Attributes of an `<?xml …?>` prolog, when present. */
export interface XmlPrologInfo {
  version?: string;
  encoding?: string;
  standalone?: string;
}

/** Result of {@linkcode parseOfxHeader}. */
export interface OfxHeaderResult {
  /** Header keys, uppercased (duplicates: last one wins). Empty when no header was recognized. */
  header: Record<string, string>;
  /** OFX major version derived from `OFXHEADER`/`VERSION`. */
  version: '1' | '2' | 'unknown';
  /** XML prolog attributes, when an `<?xml …?>` declaration was present. */
  xmlProlog?: XmlPrologInfo | undefined;
  /** Character offset where the header ends and the body starts. */
  endOffset: number;
  warnings: ParseWarning[];
}

/** Options for {@linkcode parseOfxHeader}. */
export interface ParseHeaderOptions {
  /** Throw `OfxParseError` on the first problem instead of collecting warnings. */
  strict?: boolean;
}

/** Whitespace tolerated between header keys/values/PIs. */
function isLooseWhitespace(char: string | undefined): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\r' ||
    char === '\n' ||
    char === '\0' ||
    char === '\ufeff'
  );
}

function isInlineWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function isKeyStart(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z'));
}

function isKeyChar(char: string | undefined): boolean {
  return (
    isKeyStart(char) ||
    (char !== undefined && ((char >= '0' && char <= '9') || char === '-' || char === '_'))
  );
}

function skipWhitespace(text: string, pos: number): number {
  while (pos < text.length && isLooseWhitespace(text[pos])) {
    pos++;
  }
  return pos;
}

function skipInlineWhitespace(text: string, pos: number): number {
  while (pos < text.length && isInlineWhitespace(text[pos])) {
    pos++;
  }
  return pos;
}

/**
 * Header keys that may appear concatenated on one line
 * (`OFXHEADER:100ENCODING:USASCII<OFX>`). Only a known key followed by a
 * colon ends a value, so words inside values (`http:`, `SASCIICHARSET:`)
 * can never split them.
 */
const CONCATENABLE_KEYS: ReadonlySet<string> = new Set([
  'OFXHEADER',
  'DATA',
  'VERSION',
  'SECURITY',
  'ENCODING',
  'CHARSET',
  'COMPRESSION',
  'OLDFILEUID',
  'NEWFILEUID',
]);

/**
 * True when `i` starts an uppercase known `KEY:` pattern — used to split
 * concatenated one-line headers, where key:value pairs follow each other
 * without newlines.
 */
function isConcatenatedKeyBoundary(text: string, i: number): boolean {
  const head = text[i];
  if (head === undefined || head < 'A' || head > 'Z') {
    return false;
  }
  let j = i + 1;
  while (j < text.length && isKeyChar(text[j])) {
    j++;
  }
  return text[j] === ':' && CONCATENABLE_KEYS.has(text.slice(i, j));
}

interface ParsedInstruction {
  attrs: Record<string, string>;
  pos: number;
  /** How the instruction ended; `gt`/`eof` mean it was unterminated. */
  end: 'pi' | 'gt' | 'eof';
}

/** Parses `NAME ATTR="v" …` until `?>` (well-formed), `>`, or end of input. */
function parseProcessingInstruction(text: string, pos: number): ParsedInstruction {
  const attrs: Record<string, string> = {};
  const length = text.length;
  while (pos < length) {
    pos = skipWhitespace(text, pos);
    if (pos >= length) {
      return { attrs, pos, end: 'eof' };
    }
    const char = text[pos];
    if (char === '?') {
      if (text[pos + 1] === '>') {
        return { attrs, pos: pos + 2, end: 'pi' };
      }
      pos++;
      continue;
    }
    if (char === '>') {
      return { attrs, pos: pos + 1, end: 'gt' };
    }
    if (!isKeyStart(char)) {
      // Tolerate garbage between attributes; always make progress.
      pos++;
      continue;
    }
    const nameStart = pos;
    while (pos < length && isKeyChar(text[pos])) {
      pos++;
    }
    const name = text.slice(nameStart, pos).toUpperCase();
    pos = skipWhitespace(text, pos);
    if (text[pos] !== '=') {
      attrs[name] = '';
      continue;
    }
    pos = skipWhitespace(text, pos + 1);
    const quote = text[pos];
    if (quote === '"' || quote === "'") {
      pos++;
      const valueStart = pos;
      while (pos < length && text[pos] !== quote) {
        pos++;
      }
      attrs[name] = text.slice(valueStart, pos);
      pos = pos < length ? pos + 1 : pos;
    } else {
      const valueStart = pos;
      while (
        pos < length &&
        !isLooseWhitespace(text[pos]) &&
        text[pos] !== '?' &&
        text[pos] !== '>'
      ) {
        pos++;
      }
      attrs[name] = text.slice(valueStart, pos);
    }
  }
  return { attrs, pos, end: 'eof' };
}

function parseKeyValueHeader(
  text: string,
  pos: number,
): { header: Record<string, string>; endOffset: number } {
  const header: Record<string, string> = {};
  const length = text.length;
  while (pos < length) {
    pos = skipWhitespace(text, pos);
    if (pos >= length || text[pos] === '<') {
      break;
    }
    if (!isKeyStart(text[pos])) {
      break; // unrecognized line: the header block ends here
    }
    const keyStart = pos;
    while (pos < length && isKeyChar(text[pos])) {
      pos++;
    }
    const key = text.slice(keyStart, pos).toUpperCase();
    pos = skipInlineWhitespace(text, pos);
    if (text[pos] !== ':') {
      break; // a word without a colon is not a header line
    }
    pos = skipInlineWhitespace(text, pos + 1);
    // Value: until end of line, `<`, NUL, or a concatenated `KEY:` boundary.
    const valueStart = pos;
    let valueEnd = pos;
    while (pos < length) {
      const char = text[pos];
      if (char === undefined || char === '\r' || char === '\n' || char === '<' || char === '\0') {
        break;
      }
      if (pos > valueStart && isConcatenatedKeyBoundary(text, pos)) {
        break;
      }
      pos++;
      valueEnd = pos;
    }
    header[key] = text.slice(valueStart, valueEnd).trimEnd();
  }
  return { header, endOffset: pos };
}

function detectVersion(header: Readonly<Record<string, string>>): '1' | '2' | 'unknown' {
  const raw = header.OFXHEADER ?? header.VERSION;
  if (raw === undefined) {
    return 'unknown';
  }
  const match = /^\s*([12])/.exec(raw);
  const major = match?.[1];
  return major === '1' || major === '2' ? major : 'unknown';
}

/**
 * Parses the OFX header of an already-decoded OFX file.
 *
 * Accepts OFX 1.x key:value headers, OFX 2.x `<?OFX …?>` processing
 * instructions (with or without a following XML prolog, in either order) and
 * tolerates missing or garbage headers. Keys are uppercased; duplicate keys
 * keep the last value. `endOffset` points at the first body character
 * (usually `<OFX>`).
 */
export function parseOfxHeader(text: string, options: ParseHeaderOptions = {}): OfxHeaderResult {
  const warnings: ParseWarning[] = [];
  const header: Record<string, string> = {};
  let xmlProlog: XmlPrologInfo | undefined;
  let pos = skipWhitespace(text, 0);
  const headerStart = pos;

  if (text[pos] === '<' && text[pos + 1] === '?') {
    // OFX 2.x style: a sequence of processing instructions, then the body.
    while (pos < text.length && text[pos] === '<' && text[pos + 1] === '?') {
      const piStart = pos;
      pos += 2;
      const nameStart = pos;
      while (
        pos < text.length &&
        !isLooseWhitespace(text[pos]) &&
        text[pos] !== '?' &&
        text[pos] !== '>'
      ) {
        pos++;
      }
      const name = text.slice(nameStart, pos).toLowerCase();
      const instruction = parseProcessingInstruction(text, pos);
      pos = instruction.pos;

      if (name === 'xml') {
        xmlProlog = {
          version: instruction.attrs.VERSION,
          encoding: instruction.attrs.ENCODING,
          standalone: instruction.attrs.STANDALONE,
        };
      } else if (name === 'ofx') {
        for (const [key, value] of Object.entries(instruction.attrs)) {
          header[key] = value;
        }
      }
      // Other processing instructions (xml-stylesheet etc.) are skipped.

      if (instruction.end !== 'pi') {
        const { line, column } = offsetToLineColumn(text, piStart);
        warnings.push({
          code: 'header-unterminated',
          message: `Unterminated processing instruction '${name.toUpperCase()}'`,
          line,
          column,
        });
      }
      pos = skipWhitespace(text, pos);
    }
  } else {
    const parsed = parseKeyValueHeader(text, pos);
    for (const [key, value] of Object.entries(parsed.header)) {
      header[key] = value;
    }
    pos = parsed.endOffset;
  }

  if (Object.keys(header).length === 0) {
    const { line, column } = offsetToLineColumn(text, headerStart);
    if (options.strict) {
      throw new OfxParseError('Missing or unrecognized OFX header', {
        code: 'missing-header',
        line,
        column,
      });
    }
    warnings.push({
      code: 'missing-header',
      message: 'Missing or unrecognized OFX header',
      line,
      column,
    });
  }

  return {
    header,
    version: detectVersion(header),
    xmlProlog,
    endOffset: pos,
    warnings,
  };
}
