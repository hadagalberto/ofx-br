/**
 * Entity decoding for SGML/XML text and attribute values.
 *
 * OFX files in the wild contain the five predefined XML entities
 * (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`), numeric character references
 * (`&#65;` `&#x41;`), occasional `&nbsp;`, and — because Brazilian banks paste
 * unescaped text — raw `&` characters that are not entities at all. The
 * scanner therefore never fails on an `&`: it decodes what it recognizes,
 * reports what looks like an entity but is unknown, and keeps everything
 * else as literal text.
 */

/** Outcome of scanning an `&` in text. */
export type EntityScan =
  | { readonly kind: 'known'; readonly value: string; readonly length: number }
  /** Well-formed reference (`&foo;`, `&#xZZ;`) with an unsupported name — kept literally. */
  | { readonly kind: 'unknown'; readonly length: number };

/** Predefined XML entities plus `&nbsp;`, which appears in bank memos. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
]);

/** Longest entity name worth recognizing before treating an `&` as literal. */
const MAX_ENTITY_NAME_LENGTH = 32;

const REPLACEMENT = '\ufffd';

function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameChar(code: number): boolean {
  return (
    isNameStart(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f /* _ */ ||
    code === 0x2d /* - */
  );
}

function isDecimal(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHex(code: number): boolean {
  return isDecimal(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * Maps a numeric character reference to text, recovering instead of throwing:
 * surrogates, out-of-range values and control characters (other than the
 * three XML whitespace characters) become U+FFFD.
 */
function codePointToText(code: number): string {
  if (
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
  ) {
    return REPLACEMENT;
  }
  return String.fromCodePoint(code);
}

/**
 * Tries to decode an entity reference starting at `text[at]`, which must be
 * `'&'`. Returns `undefined` when the `&` is not followed by anything that
 * looks like an entity (raw `&`, truncated reference, overlong name): the
 * caller keeps it as literal text.
 */
export function tryDecodeEntity(text: string, at: number): EntityScan | undefined {
  const length = text.length;
  let pos = at + 1;
  if (pos >= length) {
    return undefined;
  }

  const first = text.charCodeAt(pos);

  if (first === 0x23 /* # */) {
    pos++;
    let hex = false;
    if (pos < length) {
      const marker = text.charCodeAt(pos);
      if (marker === 0x78 /* x */ || marker === 0x58 /* X */) {
        hex = true;
        pos++;
      }
    }
    const digitsStart = pos;
    while (pos < length && (hex ? isHex(text.charCodeAt(pos)) : isDecimal(text.charCodeAt(pos)))) {
      pos++;
    }
    const digits = text.slice(digitsStart, pos);
    if (digits === '' || pos >= length || text.charCodeAt(pos) !== 0x3b /* ; */) {
      return undefined; // not a terminated numeric reference: literal '&'
    }
    const code = Number.parseInt(digits, hex ? 16 : 10);
    return { kind: 'known', value: codePointToText(code), length: pos + 1 - at };
  }

  if (!isNameStart(first)) {
    return undefined;
  }
  const nameStart = pos;
  while (
    pos < length &&
    pos - nameStart < MAX_ENTITY_NAME_LENGTH &&
    isNameChar(text.charCodeAt(pos))
  ) {
    pos++;
  }
  if (pos >= length || text.charCodeAt(pos) !== 0x3b /* ; */) {
    return undefined; // no semicolon within the name budget: literal '&'
  }
  const name = text.slice(nameStart, pos);
  const value = NAMED_ENTITIES.get(name);
  if (value === undefined) {
    return { kind: 'unknown', length: pos + 1 - at };
  }
  return { kind: 'known', value, length: pos + 1 - at };
}
