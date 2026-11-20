/**
 * The full OFX pipeline (SPEC.md "Parsing pipeline"): decode → header →
 * SGML/XML tree → normalized model.
 *
 * `parse` takes already-decoded text; `parseBuffer` runs the byte-level stage
 * first (encoding detection, mojibake repair) and keeps those warnings. Both
 * are total in lenient mode (the default): nothing throws, every repair is a
 * warning with a code and a 1-based line/column. With `strict: true` the
 * first problem throws {@linkcode OfxParseError}.
 */
import { decodeOfx } from './encoding/decode.js';
import { parseOfxHeader } from './header.js';
import { mapDocument } from './mapping.js';
import type { OfxDocument } from './model.js';
import { parseSgml } from './sgml/tree.js';
import { parseTimeZoneOffset } from './datetime.js';
import type { ParseWarning } from './types.js';

/** Options for {@linkcode parse} and {@linkcode parseBuffer}. */
export interface ParseOptions {
  /** Throw `OfxParseError` on the first problem (header, tree or mapping) instead of collecting warnings. */
  strict?: boolean;
  /**
   * Timezone applied to date/time values that carry no `[offset]` suffix.
   * Accepts `'-03:00'`, `'-3'`, `'3'`, `'+05:30'`. Default: `'-03:00'`
   * (BRT — Brazil has had no DST since 2019). An invalid value warns
   * (`invalid-tz-option`) and falls back to the default.
   */
  tz?: string;
  /**
   * Encoding recorded on the document when parsing from text (you already
   * know how the text was decoded). Default: `'unknown'`.
   * `parseBuffer` always records the encoding it actually used.
   */
  encoding?: string;
  /**
   * Check that each statement's transaction sum equals its `LEDGERBAL` and
   * report mismatches as `balance-mismatch` warnings (thrown in strict
   * mode). Only meaningful when the export lists every movement since the
   * account opening. Default: off.
   */
  verifyBalance?: boolean;
}

/** The default BRT offset applied to datetimes without a timezone suffix. */
const DEFAULT_OFFSET_MINUTES = -3 * 60;

interface ResolvedOffset {
  minutes: number;
  warnings: ParseWarning[];
}

/** Resolves the `tz` option (default `-03:00`), warning when it is invalid. */
function resolveDefaultOffset(tz: string | undefined): ResolvedOffset {
  if (tz === undefined) {
    return { minutes: DEFAULT_OFFSET_MINUTES, warnings: [] };
  }
  const minutes = parseTimeZoneOffset(tz);
  if (minutes !== undefined) {
    return { minutes, warnings: [] };
  }
  return {
    minutes: DEFAULT_OFFSET_MINUTES,
    warnings: [
      {
        code: 'invalid-tz-option',
        message: `Timezone option ${JSON.stringify(tz)} could not be parsed; the default -03:00 was used`,
      },
    ],
  };
}

/**
 * Parses an already-decoded OFX document (SGML or XML body) into the
 * normalized model. Never throws in lenient mode; with `strict: true` the
 * first problem throws `OfxParseError` with a code and 1-based line/column.
 */
export function parse(text: string, options: ParseOptions = {}): OfxDocument {
  const offset = resolveDefaultOffset(options.tz);

  const header = parseOfxHeader(text, { strict: options.strict });
  const body = parseSgml(text, {
    startOffset: header.endOffset,
    flavor: header.version === '2' ? 'xml' : 'sgml',
    strict: options.strict,
  });
  const mapped = mapDocument(body.root, {
    text,
    defaultOffsetMinutes: offset.minutes,
    strict: options.strict,
    verifyBalance: options.verifyBalance,
  });

  return {
    header: header.header,
    version: header.version,
    signOn: mapped.signOn,
    statements: mapped.statements,
    warnings: [...offset.warnings, ...header.warnings, ...body.warnings, ...mapped.warnings],
    encoding: options.encoding ?? 'unknown',
  };
}

/**
 * Parses OFX bytes into the normalized model: detects the encoding, decodes
 * (repairing mojibake and lying headers, with warnings), then runs
 * {@linkcode parse}. The recorded `encoding` is the one actually used.
 */
export function parseBuffer(
  bytes: Uint8Array,
  options: Omit<ParseOptions, 'encoding'> = {},
): OfxDocument {
  const decoded = decodeOfx(bytes);
  const document = parse(decoded.text, {
    strict: options.strict,
    tz: options.tz,
    encoding: decoded.encoding,
    verifyBalance: options.verifyBalance,
  });
  document.warnings = [...decoded.warnings, ...document.warnings];
  return document;
}
