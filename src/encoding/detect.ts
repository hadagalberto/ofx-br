/**
 * Encoding detection for OFX byte buffers.
 *
 * Order of authority, matching how real Brazilian banks export files:
 *
 * 1. Byte-order marks (UTF-8/UTF-16/UTF-32) — always trusted;
 * 2. NUL-interleaved pattern (UTF-16 without BOM — common from Windows tools);
 * 3. The OFX header declaration (`ENCODING`/`CHARSET`) read from an
 *    ASCII-safe window of the raw bytes;
 * 4. The XML prolog `encoding` attribute (OFX 2.x);
 * 5. Heuristics: valid UTF-8 → UTF-8, else windows-1252.
 *
 * Wide declarations (UTF-16/UTF-32) are only honoured when the bytes agree
 * (BOM or NUL pattern); a lying header is recorded but not trusted, and the
 * decoder emits a warning.
 */
import { parseOfxHeader } from '../header.js';
import { pickDeclaredEncoding } from './labels.js';
import { scanUtf8 } from './utf8.js';
import { codeUnitsToString } from './tables.js';
import type { DeclaredCharset, EncodingDetection, EncodingName } from './types.js';

/** Bytes of header examined for charset declarations. Header keys/values are ASCII in practice. */
const HEADER_WINDOW_LIMIT = 2048;

export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  if (bytes.length === 0) {
    return { encoding: 'utf-8', source: 'empty', bom: false };
  }

  const bom = detectByteOrderMark(bytes);
  if (bom) {
    // The window after a UTF-16/32 BOM is NUL-interleaved and yields no
    // readable declaration; after a UTF-8 BOM the header is plain ASCII.
    const declared = readDeclaredCharset(bytes, bom.length);
    return attachDeclaration({ encoding: bom.encoding, source: 'bom', bom: true }, declared);
  }

  const utf16 = detectUtf16Pattern(bytes);
  if (utf16) {
    return { encoding: utf16, source: 'utf16-pattern', bom: false };
  }

  const declared = readDeclaredCharset(bytes, 0);
  if (declared?.encoding !== undefined && !isWideEncoding(declared.encoding)) {
    return attachDeclaration(
      { encoding: declared.encoding, source: declared.origin, bom: false },
      declared,
    );
  }

  // Unknown or unreliable declaration (or none at all): content heuristics.
  const scan = scanUtf8(bytes);
  const heuristic: EncodingDetection = scan.valid
    ? { encoding: 'utf-8', source: 'utf8-heuristic', bom: false }
    : { encoding: 'windows-1252', source: 'fallback', bom: false };
  return attachDeclaration(
    heuristic,
    declared === undefined ? undefined : { ...declared, encoding: undefined },
  );
}

/** BOM length in bytes, given that `detectEncoding` reported `bom: true`. */
export function byteOrderMarkLength(bytes: Uint8Array): number {
  const bom = detectByteOrderMark(bytes);
  return bom ? bom.length : 0;
}

interface ByteOrderMark {
  encoding: EncodingName;
  length: number;
}

/**
 * UTF-32 BOMs must be tested before UTF-16 ones: `FF FE 00 00` starts with
 * the UTF-16LE BOM bytes.
 */
function detectByteOrderMark(bytes: Uint8Array): ByteOrderMark | undefined {
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
      return { encoding: 'utf-32le', length: 4 };
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
      return { encoding: 'utf-32be', length: 4 };
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 };
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { encoding: 'utf-16le', length: 2 };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { encoding: 'utf-16be', length: 2 };
    }
  }
  return undefined;
}

/**
 * Detects BOM-less UTF-16 by scoring NUL-interleaved ASCII pairs over the
 * first bytes: ASCII text in UTF-16 has a NUL in every other position. The
 * threshold (≥ 4 scored pairs, at least half of them) is high enough that
 * NUL-padded single-byte files cannot trigger it.
 */
function detectUtf16Pattern(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const limit = Math.min(bytes.length, 64);
  if (limit < 8) {
    return undefined;
  }
  const pairs = limit >> 1;
  let littleEndian = 0;
  let bigEndian = 0;
  for (let i = 0; i + 1 < limit; i += 2) {
    const even = bytes[i];
    const odd = bytes[i + 1];
    if (even !== 0 && odd === 0) {
      littleEndian++;
    } else if (even === 0 && odd !== 0) {
      bigEndian++;
    }
  }
  if (littleEndian >= 4 && littleEndian >= pairs / 2) {
    return 'utf-16le';
  }
  if (bigEndian >= 4 && bigEndian >= pairs / 2) {
    return 'utf-16be';
  }
  return undefined;
}

/**
 * Reads the charset declaration from the first bytes. Bytes above 0x7F
 * become U+FFFD, which stops header parsing exactly where the file stops
 * being header-shaped — body text (where the accents live) never leaks into
 * the decision.
 */
function readDeclaredCharset(bytes: Uint8Array, start: number): DeclaredCharset | undefined {
  if (start >= bytes.length) {
    return undefined;
  }
  const parsed = parseOfxHeader(asciiWindow(bytes, start));
  return pickDeclaredEncoding(parsed.header, parsed.xmlProlog?.encoding);
}

/** ASCII-safe view of the first bytes: values above 0x7F become U+FFFD. */
function asciiWindow(bytes: Uint8Array, start: number): string {
  const end = Math.min(bytes.length, start + HEADER_WINDOW_LIMIT);
  const units: number[] = [];
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    units.push(b === undefined || b > 0x7f ? 0xfffd : b);
  }
  return codeUnitsToString(units);
}

function isWideEncoding(encoding: EncodingName): boolean {
  return encoding.startsWith('utf-16') || encoding.startsWith('utf-32');
}

function attachDeclaration(
  base: EncodingDetection,
  declared: DeclaredCharset | undefined,
): EncodingDetection {
  if (declared === undefined) {
    return base;
  }
  return {
    ...base,
    declaredLabel: declared.label,
    declaredEncoding: declared.encoding,
  };
}
