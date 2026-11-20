/**
 * Lenient SGML/XML tokenizer and tree builder for the OFX document body.
 *
 * Real Brazilian bank exports violate the format in every way that matters:
 * leaf elements are never closed (`<TRNAMT>-10.00`), aggregates are left
 * open, tag case does not match, memos contain raw `&` and raw `<`, the whole
 * file sits on one huge line, CRLF/LF/CR are mixed, NUL bytes leak in from
 * broken exporters, closing tags are duplicated, and garbage trails the
 * document. This module never throws in lenient mode: it repairs what it can,
 * builds a generic element tree, and reports every repair as a
 * {@linkcode ParseWarning} with a stable code and a 1-based line/column.
 * With `strict: true` the first problem throws an {@linkcode OfxParseError}
 * carrying the same code and location.
 *
 * Design notes:
 *
 * - The tree has a synthetic `'#document'` root whose children are the
 *   top-level elements (normally a single `<OFX>`). A wrapper-less body with
 *   several top-level message sets is therefore parsed, not rejected.
 * - SGML is case-insensitive; element names are normalized to uppercase.
 * - Leaf vs. aggregate is decided structurally: an element that has text
 *   content is a leaf and is implicitly closed when the next tag opens (the
 *   OFX 1.x DTD makes leaf end tags optional, so this is silent in the default
 *   `sgml` flavor); an element with child elements stays open for more
 *   children. A whitespace-only element is treated as an aggregate because
 *   real exports emit empty aggregates (`<BANKTRANLIST>`) but omit empty
 *   leaves entirely.
 * - The OFX DTD never nests an element inside a same-name element, so when a
 *   tag opens while a same-name element is still on the stack, the open one is
 *   treated as an unfinished sibling (repeated unclosed `<STMTTRN>`,
 *   `<STATUS>`, …) and closed implicitly — never nested into.
 * - Entities (`&amp;`, `&#65;`, `&#x41;`) are decoded; unknown but
 *   well-formed references (`&foo;`) are kept literally with a warning; a raw
 *   `&` that cannot start an entity is kept as text, silently.
 * - NUL bytes are treated as ignorable whitespace and stripped everywhere;
 *   a single `nul-byte` warning reports how many were removed.
 * - Comments, processing instructions and `<!...>` declarations in the body
 *   are skipped.
 */
import { OfxParseError } from '../errors.js';
import { offsetToLineColumn } from '../text.js';
import { tryDecodeEntity } from './entities.js';
import type { ParseWarning } from '../types.js';

/** Syntax flavor: OFX 1.x SGML (default) or OFX 2.x XML. */
export type SgmlFlavor = 'sgml' | 'xml';

/** Warning codes emitted by {@linkcode parseSgml}. */
export type SgmlWarningCode =
  | 'unclosed-aggregate'
  | 'unclosed-leaf'
  | 'duplicate-close-tag'
  | 'stray-close-tag'
  | 'stray-text'
  | 'trailing-garbage'
  | 'unknown-entity'
  | 'nul-byte'
  | 'unterminated-tag'
  | 'unterminated-comment'
  | 'unterminated-cdata'
  | 'implicit-sibling-close'
  | 'warnings-truncated';

/** One element of the generic parse tree. */
export interface SgmlElement {
  /** Element name, normalized to uppercase. The synthetic root is `'#document'`. */
  name: string;
  /** 0-based offset of the opening `<` in the source text; the root carries the body start. */
  offset: number;
  /** Child elements in document order. */
  children: SgmlElement[];
  /** Attributes parsed from the opening tag (rare in OFX; XML-style exports). */
  attributes?: Record<string, string>;
  /**
   * Decoded text content of a leaf: leading/trailing whitespace removed,
   * interior whitespace (including newlines) preserved exactly.
   */
  text?: string;
}

/** Result of {@linkcode parseSgml}. */
export interface SgmlParseResult {
  /** Synthetic document root (`'#document'`) holding the top-level elements. */
  root: SgmlElement;
  /** Problems found and repaired, in document order. */
  warnings: ParseWarning[];
}

/** Options for {@linkcode parseSgml}. */
export interface SgmlParseOptions {
  /**
   * Offset where the body starts, when `text` includes the OFX header.
   * Offsets, lines and columns in warnings and elements remain file-global.
   * Default: `0`.
   */
  startOffset?: number;
  /**
   * `'sgml'` (OFX 1.x, default): unclosed leaf elements are legal and
   * silent. `'xml'` (OFX 2.x): unclosed leaves are repaired with an
   * `unclosed-leaf` warning (or an error in strict mode).
   */
  flavor?: SgmlFlavor;
  /** Throw `OfxParseError` on the first problem instead of collecting warnings. */
  strict?: boolean;
}

/** Hard cap on recorded warnings; beyond it repairs still happen but are only counted. */
const MAX_WARNINGS = 1000;

/** Name of the synthetic document root. */
const DOCUMENT_ROOT_NAME = '#document';

/**
 * Aggregates the OFX DTD declares as siblings, never nested: an unclosed
 * `<LEDGERBAL>` must not swallow the following `<AVAILBAL>` (independent
 * review finding 7). Opening one closes any member of this set still open.
 */
const EXCLUSIVE_SIBLING_AGGREGATES: ReadonlySet<string> = new Set(['LEDGERBAL', 'AVAILBAL']);

interface BuilderOptions {
  readonly startOffset: number;
  readonly flavor: SgmlFlavor;
  readonly strict: boolean;
}

/** Text-accumulation state for one open element; the tree is built in place. */
interface Frame {
  readonly name: string;
  readonly element: SgmlElement;
  textBuffer: string;
  /** True once non-whitespace text reached this element (it is a leaf). */
  hasTextContent: boolean;
}

/** A problem recorded in lenient mode; line/column is resolved after sorting. */
interface PendingWarning {
  readonly offset: number;
  readonly code: SgmlWarningCode;
  readonly message: string;
}

/** Monotonic cursor for cheap ascending offset → line/column resolution. */
interface LineCursor {
  scanned: number;
  line: number;
  lineStart: number;
}

interface OpenAttribute {
  readonly pos: number;
  readonly name: string;
  readonly value: string;
}

function isWsCode(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // LF
    code === 0x0d || // CR
    code === 0x0b || // VT
    code === 0x0c || // FF
    code === 0x00 || // NUL — stripped with a warning
    code === 0xfeff // BOM
  );
}

function isNameStartCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameCode(code: number): boolean {
  return isNameStartCode(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x2d;
}

/** True when the `<` at `pos` starts markup (tag, close tag, declaration or PI). */
function isMarkupStart(text: string, pos: number): boolean {
  if (text.charCodeAt(pos) !== 0x3c) {
    return false;
  }
  const next = text.charCodeAt(pos + 1);
  return (
    isNameStartCode(next) || next === 0x2f /* / */ || next === 0x21 /* ! */ || next === 0x3f /* ? */
  );
}

function hasNonWs(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!isWsCode(text.charCodeAt(i))) {
      return true;
    }
  }
  return false;
}

/** Trims the ignorable whitespace class (not NBSP) from both ends. */
function trimEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWsCode(text.charCodeAt(start))) {
    start++;
  }
  while (end > start && isWsCode(text.charCodeAt(end - 1))) {
    end--;
  }
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

/** Short quoted preview for warning messages. */
function snippet(text: string): string {
  const MAX_SNIPPET_LENGTH = 24;
  const shown = text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}...` : text;
  return JSON.stringify(shown);
}

class SgmlBuilder {
  private readonly stack: Frame[] = [];
  private readonly openedNames = new Set<string>();
  private readonly nameCache = new Map<string, string>();
  private readonly pending: PendingWarning[] = [];
  private readonly root: SgmlElement;
  private suppressed = 0;
  private nulCount = 0;
  private nulFirstOffset = -1;

  constructor(
    private readonly text: string,
    private readonly options: BuilderOptions,
  ) {
    this.root = { name: DOCUMENT_ROOT_NAME, offset: options.startOffset, children: [] };
  }

  run(): SgmlParseResult {
    const text = this.text;
    let pos = this.options.startOffset;
    while (pos < text.length) {
      pos = isMarkupStart(text, pos) ? this.scanMarkup(pos) : this.scanTextRun(pos);
    }
    // Elements still open at EOF are closed implicitly, reported in document
    // order (outermost first) so strict mode throws on the earliest problem.
    for (const frame of this.stack) {
      this.finalizeImplicit(frame);
    }
    this.stack.length = 0;
    if (this.nulCount > 0) {
      this.addWarning(
        'nul-byte',
        `Stripped ${this.nulCount} NUL byte(s) from the document body`,
        this.nulFirstOffset,
      );
    }
    this.pending.sort((a, b) => a.offset - b.offset);
    // Line/column is resolved in one ascending pass over the text, so a
    // hostile document can never cost more than a single scan.
    const warnings: ParseWarning[] = [];
    const cursor: LineCursor = { scanned: 0, line: 1, lineStart: 0 };
    for (const entry of this.pending) {
      const { line, column } = this.advanceLineColumn(entry.offset, cursor);
      warnings.push({ code: entry.code, message: entry.message, line, column });
    }
    if (this.suppressed > 0) {
      const { line, column } = this.advanceLineColumn(text.length, cursor);
      warnings.push({
        code: 'warnings-truncated',
        message: `${this.suppressed} further problem(s) were found and repaired, but not reported (warning limit of ${MAX_WARNINGS} reached)`,
        line,
        column,
      });
    }
    return { root: this.root, warnings };
  }

  // ---------------------------------------------------------------- Warnings

  /** Records a problem, or throws `OfxParseError` for it in strict mode. */
  private report(code: SgmlWarningCode, message: string, offset: number): void {
    if (this.options.strict) {
      throw this.buildError(code, message, offset);
    }
    this.addWarning(code, message, offset);
  }

  /** Records a problem in lenient mode only (callers guarantee lenient context). */
  private addWarning(code: SgmlWarningCode, message: string, offset: number): void {
    if (this.pending.length >= MAX_WARNINGS) {
      this.suppressed++;
      return;
    }
    this.pending.push({ offset, code, message });
  }

  private buildError(code: SgmlWarningCode, message: string, offset: number): OfxParseError {
    const { line, column } = offsetToLineColumn(this.text, offset);
    return new OfxParseError(message, { code, line, column });
  }

  /**
   * Resolves an offset to a 1-based line/column, advancing `cursor`
   * monotonically. Only valid for non-decreasing offsets (guaranteed after
   * the final sort); a defensive full scan covers anything else.
   */
  private advanceLineColumn(offset: number, cursor: LineCursor): { line: number; column: number } {
    if (offset < cursor.scanned) {
      return offsetToLineColumn(this.text, offset);
    }
    const text = this.text;
    for (let i = cursor.scanned; i < offset; i++) {
      if (text.charCodeAt(i) === 0x0a) {
        cursor.line++;
        cursor.lineStart = i + 1;
      }
    }
    cursor.scanned = offset;
    return { line: cursor.line, column: offset - cursor.lineStart + 1 };
  }

  /** Counts one stripped NUL byte, or throws on it in strict mode. */
  private noteNul(offset: number): void {
    if (this.options.strict) {
      throw this.buildError('nul-byte', 'NUL byte in document body', offset);
    }
    if (this.nulCount === 0) {
      this.nulFirstOffset = offset;
    }
    this.nulCount++;
  }

  /** Writes the accumulated (trimmed) text onto an element being closed. */
  private closeElement(frame: Frame): void {
    const trimmed = trimEdges(frame.textBuffer);
    if (trimmed !== '') {
      frame.element.text = trimmed;
    }
  }

  /**
   * Classifies an element that never saw its closing tag and was closed
   * implicitly (by a sibling, an ancestor's closing tag, or end of input).
   */
  private finalizeImplicit(frame: Frame): void {
    this.closeElement(frame);
    if (frame.element.children.length > 0) {
      this.report(
        'unclosed-aggregate',
        `Element <${frame.name}> is not closed; it was closed implicitly`,
        frame.element.offset,
      );
      return;
    }
    if (frame.hasTextContent && this.options.flavor === 'xml') {
      this.report(
        'unclosed-leaf',
        `Element <${frame.name}> has no closing tag (XML requires end tags); it was closed implicitly`,
        frame.element.offset,
      );
    }
    // SGML flavor: an unclosed leaf is legal per the OFX 1.x DTD — silent.
    // Whitespace-only empty elements stay silent in both flavors.
  }

  // ------------------------------------------------------------------ Scans

  private scanMarkup(pos: number): number {
    const next = this.text.charCodeAt(pos + 1);
    if (next === 0x2f) {
      return this.scanCloseTag(pos);
    }
    if (next === 0x21) {
      return this.scanDeclaration(pos);
    }
    if (next === 0x3f) {
      return this.scanProcessingInstruction(pos);
    }
    return this.scanOpenTag(pos);
  }

  /**
   * Scans a text run up to the next real markup in a single pass, classifying
   * characters on the way. Chunks free of `&` and NUL are used as-is; the
   * others go through entity decoding.
   */
  private scanTextRun(from: number): number {
    const text = this.text;
    const length = text.length;
    let pos = from;
    let sawContent = false;
    let contentAt = -1;
    let needsDecoding = false;
    while (pos < length) {
      const code = text.charCodeAt(pos);
      if (code === 0x3c /* < */) {
        if (isMarkupStart(text, pos)) {
          break;
        }
        // A '<' that cannot start markup is literal text.
        if (!sawContent) {
          sawContent = true;
          contentAt = pos;
        }
        pos++;
        continue;
      }
      if (code === 0x26 /* & */ || code === 0x00 /* NUL */) {
        needsDecoding = true;
      } else if (!sawContent && !isWsCode(code)) {
        sawContent = true;
        contentAt = pos;
      }
      pos++;
    }
    if (!needsDecoding) {
      this.routeChunk(text.slice(from, pos), from, sawContent, sawContent ? contentAt - from : -1);
      return pos;
    }
    const decoded = this.decodeTextChunk(text.slice(from, pos), from);
    this.routeChunk(decoded.value, from, decoded.sawContent, decoded.contentOffset);
    return pos;
  }

  /** Attaches a decoded text chunk to the tree (or reports it as garbage). */
  private routeChunk(
    value: string,
    from: number,
    sawContent: boolean,
    contentOffset: number,
  ): void {
    const frame = this.stack[this.stack.length - 1];
    if (frame === undefined) {
      if (!sawContent) {
        return;
      }
      const contentAt = from + contentOffset;
      if (this.root.children.length > 0) {
        this.report(
          'trailing-garbage',
          `Ignoring trailing garbage ${snippet(value)} after the document body`,
          contentAt,
        );
      } else {
        this.report(
          'stray-text',
          `Ignoring text ${snippet(value)} before the first element`,
          contentAt,
        );
      }
      return;
    }
    if (frame.element.children.length > 0) {
      if (sawContent) {
        this.report(
          'stray-text',
          `Ignoring stray text ${snippet(value)} inside <${frame.name}> after its child elements`,
          from + contentOffset,
        );
      }
      return; // whitespace between child elements is normal
    }
    frame.textBuffer += value;
    if (sawContent) {
      frame.hasTextContent = true;
    }
  }

  /**
   * Decodes one raw text chunk: entities are resolved, NUL bytes are stripped
   * (counted), unknown-but-well-formed entities warn and stay literal, and a
   * bare `&` stays literal silently.
   */
  private decodeTextChunk(
    chunk: string,
    chunkOffset: number,
  ): {
    value: string;
    sawContent: boolean;
    contentOffset: number;
  } {
    let value = '';
    let sawContent = false;
    let contentOffset = -1;
    const markContent = (index: number): void => {
      if (!sawContent) {
        sawContent = true;
        contentOffset = index;
      }
    };
    let i = 0;
    while (i < chunk.length) {
      const code = chunk.charCodeAt(i);
      if (code === 0x26 /* & */) {
        const scan = tryDecodeEntity(chunk, i);
        if (scan !== undefined) {
          if (scan.kind === 'known') {
            value += scan.value;
            if (hasNonWs(scan.value)) {
              markContent(i);
            }
          } else {
            const literal = chunk.slice(i, i + scan.length);
            this.report(
              'unknown-entity',
              `Unknown entity ${snippet(literal)} kept as literal text`,
              chunkOffset + i,
            );
            value += literal;
            markContent(i);
          }
          i += scan.length;
          continue;
        }
        value += '&';
        markContent(i);
        i++;
        continue;
      }
      if (code === 0) {
        this.noteNul(chunkOffset + i);
        i++;
        continue;
      }
      if (!isWsCode(code)) {
        markContent(i);
      }
      value += String.fromCharCode(code);
      i++;
    }
    return { value, sawContent, contentOffset };
  }

  private scanOpenTag(openOffset: number): number {
    const text = this.text;
    const length = text.length;
    let pos = openOffset + 1;
    const nameStart = pos;
    while (pos < length && isNameCode(text.charCodeAt(pos))) {
      pos++;
    }
    if (pos >= length) {
      this.report('unterminated-tag', 'Document ended inside an open tag', openOffset);
      return length;
    }
    const name = this.internName(text.slice(nameStart, pos).toUpperCase());

    let terminated = false;
    let selfClosed = false;
    let attributes: Record<string, string> | undefined;
    while (pos < length) {
      pos = this.skipInTagWhitespace(pos);
      if (pos >= length) {
        break;
      }
      const code = text.charCodeAt(pos);
      if (code === 0x3e /* > */) {
        pos++;
        terminated = true;
        break;
      }
      if (code === 0x2f /* / */) {
        pos++;
        if (pos < length && text.charCodeAt(pos) === 0x3e) {
          pos++;
          terminated = true;
          selfClosed = true;
          break;
        }
        continue; // tolerate a stray '/'
      }
      if (isNameStartCode(code)) {
        const attribute = this.scanOpenAttribute(pos);
        attributes ??= {};
        attributes[attribute.name] = attribute.value;
        pos = attribute.pos;
        continue;
      }
      pos++; // tolerate garbage inside the tag
    }
    if (!terminated) {
      this.report('unterminated-tag', 'Document ended inside an open tag', openOffset);
      return length;
    }

    // A leaf that already carries text is closed by the next opening tag.
    const top = this.stack[this.stack.length - 1];
    if (top?.hasTextContent) {
      this.finalizeImplicit(top);
      this.stack.pop();
    }
    // The OFX DTD never nests an element inside a same-name element: when the
    // same name is still open, the open one is an unfinished sibling (the
    // "aggregates closed or not" quirk — repeated unclosed <STMTTRN>, …).
    const siblingIndex = this.findInStack(name);
    if (siblingIndex >= 0) {
      for (let i = siblingIndex; i < this.stack.length; i++) {
        const frame = this.stack[i];
        if (frame !== undefined) {
          this.finalizeImplicit(frame);
        }
      }
      this.stack.length = siblingIndex;
    }
    // An aggregate from the exclusive-sibling set cannot be an ancestor of a
    // peer aggregate. Recover by closing the peer implicitly instead of
    // nesting the new element under it, and say so explicitly.
    if (EXCLUSIVE_SIBLING_AGGREGATES.has(name)) {
      const clash = this.findExclusiveSibling();
      const open = this.stack[clash];
      if (clash >= 0 && open !== undefined) {
        for (let i = clash; i < this.stack.length; i++) {
          const frame = this.stack[i];
          if (frame !== undefined) {
            this.finalizeImplicit(frame);
          }
        }
        this.stack.length = clash;
        this.report(
          'implicit-sibling-close',
          `Element <${open.name}> cannot contain <${name}>; it was closed implicitly`,
          openOffset,
        );
      }
    }
    const parent = this.stack[this.stack.length - 1]?.element ?? this.root;
    const element: SgmlElement = { name, offset: openOffset, children: [], attributes };
    parent.children.push(element);
    this.openedNames.add(name);
    if (!selfClosed) {
      this.stack.push({ name, element, textBuffer: '', hasTextContent: false });
    }
    return pos;
  }

  private scanOpenAttribute(nameStart: number): OpenAttribute {
    const text = this.text;
    const length = text.length;
    let pos = nameStart;
    while (pos < length && isNameCode(text.charCodeAt(pos))) {
      pos++;
    }
    const name = this.internName(text.slice(nameStart, pos).toUpperCase());
    pos = this.skipInTagWhitespace(pos);
    let value = '';
    if (pos < length && text.charCodeAt(pos) === 0x3d /* = */) {
      pos = this.skipInTagWhitespace(pos + 1);
      if (pos < length) {
        const quote = text.charCodeAt(pos);
        if (quote === 0x22 /* " */ || quote === 0x27 /* ' */) {
          pos++;
          const valueStart = pos;
          while (pos < length && text.charCodeAt(pos) !== quote) {
            pos++;
          }
          value = this.decodeTextChunk(text.slice(valueStart, pos), valueStart).value;
          if (pos < length) {
            pos++;
          }
        } else {
          const valueStart = pos;
          while (pos < length) {
            const code = text.charCodeAt(pos);
            if (code === 0x3e /* > */ || code === 0x2f /* / */ || isWsCode(code)) {
              break;
            }
            pos++;
          }
          value = this.decodeTextChunk(text.slice(valueStart, pos), valueStart).value;
        }
      }
    }
    return { pos, name, value };
  }

  private scanCloseTag(closeOffset: number): number {
    const text = this.text;
    const length = text.length;
    let pos = closeOffset + 2;
    const nameStart = pos;
    while (pos < length && isNameCode(text.charCodeAt(pos))) {
      pos++;
    }
    if (pos >= length) {
      this.report('unterminated-tag', 'Document ended inside a closing tag', closeOffset);
      return length;
    }
    const rawName = text.slice(nameStart, pos);
    if (rawName === '') {
      // '</>' and friends: not a nameable closing tag — skip it silently.
      pos = this.skipUntilGt(pos);
      return pos < length ? pos + 1 : length;
    }
    const name = this.internName(rawName.toUpperCase());
    pos = this.skipUntilGt(pos);
    if (pos >= length) {
      this.report('unterminated-tag', 'Document ended inside a closing tag', closeOffset);
      return length;
    }
    pos++; // past '>'

    const matchIndex = this.findInStack(name);
    if (matchIndex < 0) {
      if (this.openedNames.has(name)) {
        this.report(
          'duplicate-close-tag',
          `Closing tag </${name}> repeats an element that is already closed; ignored`,
          closeOffset,
        );
      } else {
        this.report(
          'stray-close-tag',
          `Closing tag </${name}> matches no open element; ignored`,
          closeOffset,
        );
      }
      return pos;
    }
    // Close everything above the match implicitly (in document order), then
    // the match itself.
    for (let i = matchIndex + 1; i < this.stack.length; i++) {
      const frame = this.stack[i];
      if (frame !== undefined) {
        this.finalizeImplicit(frame);
      }
    }
    const matched = this.stack[matchIndex];
    if (matched !== undefined) {
      this.closeElement(matched);
    }
    this.stack.length = matchIndex;
    return pos;
  }

  private scanDeclaration(start: number): number {
    if (this.text.startsWith('<!--', start)) {
      return this.scanComment(start);
    }
    if (this.text.startsWith('<![CDATA[', start)) {
      return this.scanCdata(start);
    }
    const pos = this.skipUntilGt(start + 2);
    if (pos >= this.text.length) {
      this.report('unterminated-tag', 'Document ended inside a declaration', start);
      return this.text.length;
    }
    return pos + 1;
  }

  private scanComment(start: number): number {
    const text = this.text;
    const length = text.length;
    let pos = start + 4;
    while (pos + 2 < length) {
      if (
        text.charCodeAt(pos) === 0x2d /* - */ &&
        text.charCodeAt(pos + 1) === 0x2d &&
        text.charCodeAt(pos + 2) === 0x3e /* > */
      ) {
        return pos + 3;
      }
      if (text.charCodeAt(pos) === 0) {
        this.noteNul(pos);
      }
      pos++;
    }
    this.report('unterminated-comment', 'Comment has no terminating "-->"', start);
    return length;
  }

  /**
   * CDATA content is literal text: `&` and `<` inside it are not entities or
   * markup. Everything up to the first `]]>` is routed to the current element
   * verbatim (independent review finding 3).
   */
  private scanCdata(start: number): number {
    const contentStart = start + '<![CDATA['.length;
    const close = this.text.indexOf(']]>', contentStart);
    if (close < 0) {
      this.report('unterminated-cdata', 'CDATA section has no terminating "]]>"', start);
      this.routeCdata(this.text.slice(contentStart), contentStart);
      return this.text.length;
    }
    this.routeCdata(this.text.slice(contentStart, close), contentStart);
    return close + ']]>'.length;
  }

  /** Attaches literal CDATA text to the open element, counting any NUL bytes. */
  private routeCdata(value: string, offset: number): void {
    let literal = '';
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 0) {
        this.noteNul(offset + i);
        continue;
      }
      literal += value.charAt(i);
    }
    let contentOffset = -1;
    for (let i = 0; i < literal.length; i++) {
      if (!isWsCode(literal.charCodeAt(i))) {
        contentOffset = i;
        break;
      }
    }
    this.routeChunk(literal, offset, contentOffset >= 0, contentOffset);
  }

  private scanProcessingInstruction(start: number): number {
    const text = this.text;
    const length = text.length;
    let pos = start + 2;
    while (pos < length) {
      const code = text.charCodeAt(pos);
      if (code === 0x3f /* ? */ && text.charCodeAt(pos + 1) === 0x3e /* > */) {
        return pos + 2;
      }
      if (code === 0x3e /* > */) {
        return pos + 1; // lenient: a PI may be closed by '>'
      }
      if (code === 0) {
        this.noteNul(pos);
      }
      pos++;
    }
    this.report('unterminated-tag', 'Document ended inside a processing instruction', start);
    return length;
  }

  // --------------------------------------------------------------- Utilities

  /** Skips ignorable whitespace (NUL included — counted) inside a tag. */
  private skipInTagWhitespace(pos: number): number {
    const text = this.text;
    while (pos < text.length) {
      const code = text.charCodeAt(pos);
      if (code === 0) {
        this.noteNul(pos);
        pos++;
        continue;
      }
      if (!isWsCode(code)) {
        break;
      }
      pos++;
    }
    return pos;
  }

  /** Scans to the next '>' (not consumed), counting NUL bytes on the way. */
  private skipUntilGt(pos: number): number {
    const text = this.text;
    while (pos < text.length) {
      const code = text.charCodeAt(pos);
      if (code === 0x3e) {
        break;
      }
      if (code === 0) {
        this.noteNul(pos);
      }
      pos++;
    }
    return pos;
  }

  private findInStack(name: string): number {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]?.name === name) {
        return i;
      }
    }
    return -1;
  }

  /** Innermost open aggregate that belongs to the exclusive-sibling set. */
  private findExclusiveSibling(): number {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const name = this.stack[i]?.name;
      if (name !== undefined && EXCLUSIVE_SIBLING_AGGREGATES.has(name)) {
        return i;
      }
    }
    return -1;
  }

  /** Reuses one string instance per distinct name (files repeat names heavily). */
  private internName(name: string): string {
    const existing = this.nameCache.get(name);
    if (existing !== undefined) {
      return existing;
    }
    this.nameCache.set(name, name);
    return name;
  }
}

/**
 * Parses the OFX document body (SGML or XML flavor) into a generic element
 * tree, leniently. Never throws on malformed input unless `strict` is set;
 * every repair is reported as a warning with a stable code and a 1-based
 * line/column computed over `text` (pass `startOffset` when `text` includes
 * the header so locations stay file-global).
 */
export function parseSgml(text: string, options: SgmlParseOptions = {}): SgmlParseResult {
  const startOffset = Math.max(0, Math.min(options.startOffset ?? 0, text.length));
  const builder = new SgmlBuilder(text, {
    startOffset,
    flavor: options.flavor ?? 'sgml',
    strict: options.strict ?? false,
  });
  return builder.run();
}
