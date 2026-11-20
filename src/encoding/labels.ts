/**
 * Canonicalization of charset labels declared by OFX headers
 * (`ENCODING`, `CHARSET`) and XML prologs (`encoding="…"`), plus the
 * header-level logic that decides which declaration wins.
 */
import type { DeclaredCharset, EncodingName } from './types.js';

/**
 * Alias table keyed by normalized labels (trimmed, uppercased, with
 * `-`, `_` and spaces removed). Values are canonical encoding names.
 * Unknown labels deliberately have no entry so detection can fall back
 * to heuristics and emit a warning.
 */
const CHARSET_ALIASES: Readonly<Record<string, EncodingName>> = {
  // UTF-8
  UTF8: 'utf-8',
  // US-ASCII
  USASCII: 'us-ascii',
  ASCII: 'us-ascii',
  ANSIX341968: 'us-ascii',
  ISOIRV: 'us-ascii',
  // windows-1252 (Brazilian banks: CHARSET:1252)
  1252: 'windows-1252',
  WINDOWS1252: 'windows-1252',
  CP1252: 'windows-1252',
  WIN1252: 'windows-1252',
  ANSI: 'windows-1252',
  XANSI: 'windows-1252',
  // ISO-8859-1
  ISO88591: 'iso-8859-1',
  LATIN1: 'iso-8859-1',
  L1: 'iso-8859-1',
  ISOLATIN1: 'iso-8859-1',
  88591: 'iso-8859-1',
  CP819: 'iso-8859-1',
  IBM819: 'iso-8859-1',
  // UTF-16 (byte order resolved by BOM or pattern detection)
  UTF16: 'utf-16le',
  UTF16LE: 'utf-16le',
  UTF16BE: 'utf-16be',
  UCS2: 'utf-16le',
  ISO10646UCS2: 'utf-16le',
  // UTF-32
  UTF32: 'utf-32le',
  UTF32LE: 'utf-32le',
  UTF32BE: 'utf-32be',
  UCS4: 'utf-32le',
  ISO10646UCS4: 'utf-32le',
};

/** Normalizes a declared label: trim, uppercase, drop `-`, `_` and spaces. */
function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '');
}

/** Canonical encoding for a declared label, or undefined when unknown. */
export function canonicalizeCharset(raw: string): EncodingName | undefined {
  return CHARSET_ALIASES[normalizeLabel(raw)];
}

/** True for `CHARSET:NONE`-style labels, which mean "nothing declared". */
function isNoneLabel(raw: string): boolean {
  return normalizeLabel(raw) === 'NONE';
}

/**
 * Picks the charset declaration to honour, in OFX order of precedence:
 *
 * 1. `ENCODING:UTF-8` (self-describing; wins over any CHARSET);
 * 2. a meaningful `CHARSET` (`1252`, `ISO-8859-1`, `UTF-8`, …);
 * 3. `ENCODING` (`USASCII`, `ISO-8859-1`, …);
 * 4. the XML prolog `encoding` attribute (OFX 2.x files without a usable header charset).
 *
 * A charset/encoding label that is present but not recognized (`CHARSET:X-9`)
 * is returned with `encoding: undefined` so the caller can warn and fall back
 * to heuristics. `NONE` labels mean "nothing declared" and are ignored.
 * Returns undefined when the file declares nothing at all.
 */
export function pickDeclaredEncoding(
  header: Readonly<Record<string, string>>,
  prologEncoding: string | undefined,
): DeclaredCharset | undefined {
  const encodingRaw = header.ENCODING;
  const charsetRaw = header.CHARSET;

  if (encodingRaw !== undefined && canonicalizeCharset(encodingRaw) === 'utf-8') {
    return { label: encodingRaw, encoding: 'utf-8', origin: 'ofx-header' };
  }
  if (charsetRaw !== undefined) {
    const charset = canonicalizeCharset(charsetRaw);
    if (charset !== undefined && charset !== 'us-ascii') {
      return { label: charsetRaw, encoding: charset, origin: 'ofx-header' };
    }
    if (charset === undefined && !isNoneLabel(charsetRaw)) {
      // Garbage charset: record it so detection can warn, then use heuristics.
      return { label: charsetRaw, encoding: undefined, origin: 'ofx-header' };
    }
  }
  if (encodingRaw !== undefined) {
    const encoding = canonicalizeCharset(encodingRaw);
    if (encoding !== undefined) {
      return { label: encodingRaw, encoding, origin: 'ofx-header' };
    }
    if (charsetRaw === undefined && !isNoneLabel(encodingRaw)) {
      return { label: encodingRaw, encoding: undefined, origin: 'ofx-header' };
    }
  }
  if (prologEncoding !== undefined) {
    return {
      label: prologEncoding,
      encoding: canonicalizeCharset(prologEncoding),
      origin: 'xml-prolog',
    };
  }
  return undefined;
}
