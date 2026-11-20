/**
 * Strict UTF-8 validation and decoding, implemented in-house so behavior is
 * identical across runtimes and the validity check doubles as the encoding
 * heuristic (`valid UTF-8 → UTF-8, else windows-1252`).
 *
 * The validator rejects overlong encodings, UTF-16 surrogate halves, code
 * points above U+10FFFF, lone continuation bytes and truncated sequences —
 * i.e. it follows the same rules as the WHATWG UTF-8 decoder.
 */
import { codeUnitsToString } from './tables.js';

/** Length of the valid UTF-8 sequence starting at `i`, or 0 when invalid. */
function sequenceLength(bytes: Uint8Array, i: number): number {
  const b0 = bytes[i];
  if (b0 === undefined || b0 <= 0x7f) {
    return b0 === undefined ? 0 : 1;
  }
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    return isContinuation(bytes, i + 1) ? 2 : 0;
  }
  if (b0 === 0xe0) {
    return isContinuationRange(bytes, i + 1, 0xa0, 0xbf) && isContinuation(bytes, i + 2) ? 3 : 0;
  }
  if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) {
    return isContinuation(bytes, i + 1) && isContinuation(bytes, i + 2) ? 3 : 0;
  }
  if (b0 === 0xed) {
    return isContinuationRange(bytes, i + 1, 0x80, 0x9f) && isContinuation(bytes, i + 2) ? 3 : 0;
  }
  if (b0 === 0xf0) {
    return isContinuationRange(bytes, i + 1, 0x90, 0xbf) &&
      isContinuation(bytes, i + 2) &&
      isContinuation(bytes, i + 3)
      ? 4
      : 0;
  }
  if (b0 >= 0xf1 && b0 <= 0xf3) {
    return isContinuation(bytes, i + 1) &&
      isContinuation(bytes, i + 2) &&
      isContinuation(bytes, i + 3)
      ? 4
      : 0;
  }
  if (b0 === 0xf4) {
    return isContinuationRange(bytes, i + 1, 0x80, 0x8f) &&
      isContinuation(bytes, i + 2) &&
      isContinuation(bytes, i + 3)
      ? 4
      : 0;
  }
  return 0; // lone continuation (0x80..0xBF), overlong lead (0xC0/0xC1), 0xF5..0xFF
}

function isContinuation(bytes: Uint8Array, i: number): boolean {
  const b = bytes[i];
  return b !== undefined && b >= 0x80 && b <= 0xbf;
}

function isContinuationRange(bytes: Uint8Array, i: number, min: number, max: number): boolean {
  const b = bytes[i];
  return b !== undefined && b >= min && b <= max;
}

/** Result of {@linkcode scanUtf8}. */
export interface Utf8Scan {
  /** True when the whole range is valid UTF-8 (including pure ASCII). */
  valid: boolean;
  /** Number of complete multi-byte sequences found before the first invalid byte. */
  multibyte: number;
  /** Offset of the first invalid byte, or undefined when the range is valid. */
  firstInvalidOffset: number | undefined;
}

/** Counts multi-byte sequences and reports the first invalid byte, if any. */
export function scanUtf8(bytes: Uint8Array, start = 0, end = bytes.length): Utf8Scan {
  let multibyte = 0;
  let i = start;
  while (i < end) {
    const len = sequenceLength(bytes, i);
    if (len === 0) {
      return { valid: false, multibyte, firstInvalidOffset: i };
    }
    if (len > 1) {
      multibyte++;
    }
    i += len;
  }
  return { valid: true, multibyte, firstInvalidOffset: undefined };
}

/** A maximal byte range that is entirely valid UTF-8 and contains at least one multi-byte sequence. */
export interface Utf8Run {
  readonly start: number;
  readonly end: number;
}

/**
 * Finds maximal valid UTF-8 runs (ASCII filler included) inside bytes that are
 * not fully valid UTF-8. Used to repair mixed-encoding files where UTF-8
 * content was concatenated onto a single-byte-encoded export.
 */
export function findUtf8Runs(bytes: Uint8Array, start = 0, end = bytes.length): Utf8Run[] {
  const runs: Utf8Run[] = [];
  let stretchStart = -1;
  let sawMultibyte = false;
  let i = start;
  while (i < end) {
    const len = sequenceLength(bytes, i);
    if (len === 0) {
      if (sawMultibyte && stretchStart >= 0) {
        runs.push({ start: stretchStart, end: i });
      }
      sawMultibyte = false;
      stretchStart = -1;
      i++;
      continue;
    }
    if (stretchStart < 0) {
      stretchStart = i;
    }
    if (len > 1) {
      sawMultibyte = true;
    }
    i += len;
  }
  if (sawMultibyte && stretchStart >= 0) {
    runs.push({ start: stretchStart, end });
  }
  return runs;
}

/** Thrown when {@linkcode decodeUtf8} meets an invalid sequence (never happens via public paths, which validate first). */
export class Utf8DecodeError extends Error {
  /** Byte offset where the invalid sequence begins. */
  readonly offset: number;

  constructor(offset: number) {
    super(`Invalid UTF-8 sequence at byte offset ${offset}`);
    this.name = 'Utf8DecodeError';
    this.offset = offset;
  }
}

/** Decodes a validated UTF-8 range; throws {@linkcode Utf8DecodeError} on invalid input. */
export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.length): string {
  const units: number[] = [];
  let i = start;
  while (i < end) {
    const len = sequenceLength(bytes, i);
    const b0 = bytes[i];
    if (len === 0 || b0 === undefined) {
      throw new Utf8DecodeError(i);
    }
    let codePoint: number;
    if (len === 1) {
      codePoint = b0;
    } else {
      const b1 = bytes[i + 1] ?? 0;
      if (len === 2) {
        codePoint = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      } else {
        const b2 = bytes[i + 2] ?? 0;
        if (len === 3) {
          codePoint = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        } else {
          const b3 = bytes[i + 3] ?? 0;
          codePoint = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        }
      }
    }
    if (codePoint > 0xffff) {
      // Astral code point → UTF-16 surrogate pair.
      const reduced = codePoint - 0x10000;
      units.push(0xd800 | (reduced >> 10), 0xdc00 | (reduced & 0x3ff));
    } else {
      units.push(codePoint);
    }
    i += len;
  }
  return codeUnitsToString(units);
}
