/**
 * In-house single-byte decode tables.
 *
 * Real-world Brazilian OFX exports declare `CHARSET:1252` or
 * `ENCODING:ISO-8859-1`, but `TextDecoder` is not guaranteed to support
 * those labels in every runtime (and in fact the WHATWG Encoding Standard
 * maps the `iso-8859-1` label to windows-1252, so it can never decode true
 * ISO-8859-1). The tables below are therefore implemented and verified
 * in-house; tests cross-check them against `TextDecoder('windows-1252')`
 * wherever a faithful oracle exists.
 */

const CHUNK_SIZE = 8192;

/** Builds a string from UTF-16 code units in fixed-size chunks (spread-call friendly). */
export function codeUnitsToString(units: readonly number[]): string {
  let out = '';
  for (let i = 0; i < units.length; i += CHUNK_SIZE) {
    const chunk = units.slice(i, i + CHUNK_SIZE);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

/** Builds a string from Unicode code points in fixed-size chunks. */
export function codePointsToString(codePoints: readonly number[]): string {
  let out = '';
  for (let i = 0; i < codePoints.length; i += CHUNK_SIZE) {
    const chunk = codePoints.slice(i, i + CHUNK_SIZE);
    out += String.fromCodePoint(...chunk);
  }
  return out;
}

// Windows-1252, bytes 0x80..0x9F. Unassigned positions (0x81, 0x8D, 0x8F,
// 0x90, 0x9D) map to their C1 control codes, matching the WHATWG encoding
// table (and therefore TextDecoder('windows-1252')).
const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Decode table for windows-1252: 256 entries, byte value → code unit. */
export const WINDOWS_1252: Uint16Array = buildTable(WINDOWS_1252_HIGH);

/** Decode table for true ISO-8859-1: byte value === code unit, for all 256 entries. */
export const ISO_8859_1: Uint16Array = buildTable([]);

function buildTable(high: readonly number[]): Uint16Array {
  const table = new Uint16Array(256);
  for (let b = 0; b < 256; b++) {
    table[b] = b >= 0x80 && b <= 0x9f ? (high[b - 0x80] ?? b) : b;
  }
  return table;
}

/**
 * Decodes bytes `[start, end)` with a single-byte table
 * (e.g. {@linkcode WINDOWS_1252} or {@linkcode ISO_8859_1}).
 */
export function decodeSingleByte(
  bytes: Uint8Array,
  table: Uint16Array,
  start = 0,
  end = bytes.length,
): string {
  const units: number[] = [];
  for (const b of bytes.subarray(start, end)) {
    // Tables always have 256 entries, so the fallback is unreachable;
    // it exists only to satisfy `noUncheckedIndexedAccess`.
    units.push(table[b] ?? 0xfffd);
  }
  return codeUnitsToString(units);
}

/**
 * Decodes bytes `[start, end)` as ISO-8859-1, repairing bytes in 0x80..0x9F
 * with the windows-1252 mapping.
 *
 * Those positions are unassigned C1 controls in ISO-8859-1 and are emitted as
 * windows-1252 punctuation (€ ‘ ’ “ ” – — …) by every real Brazilian bank
 * export, so repairing them yields the text the bank actually meant. Each
 * repaired byte is counted so the caller can emit a warning. Below 0x80 and
 * above 0x9F the two encodings are identical, so the windows-1252 table is
 * the complete repaired table.
 */
export function decodeLatin1(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): { text: string; repairedCount: number } {
  let repairedCount = 0;
  for (const b of bytes.subarray(start, end)) {
    if (b >= 0x80 && b <= 0x9f) {
      repairedCount++;
    }
  }
  return { text: decodeSingleByte(bytes, WINDOWS_1252, start, end), repairedCount };
}
