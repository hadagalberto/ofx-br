/**
 * In-house UTF-16 and UTF-32 decoding for BOM-carrying (or NUL-interleaved)
 * files. `TextDecoder` is intentionally not used, so core behavior is
 * identical in every runtime.
 */
import { codePointsToString, codeUnitsToString } from './tables.js';

/** Result of {@linkcode decodeUtf16}. */
export interface Utf16DecodeResult {
  text: string;
  /** Trailing bytes dropped because the range had odd length (truncated file). */
  droppedBytes: number;
}

/** Decodes UTF-16LE/BE; unpaired trailing bytes are dropped and reported. */
export function decodeUtf16(
  bytes: Uint8Array,
  littleEndian: boolean,
  start = 0,
  end = bytes.length,
): Utf16DecodeResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const units: number[] = [];
  let offset = 0;
  while (offset + 2 <= view.byteLength) {
    units.push(view.getUint16(offset, littleEndian));
    offset += 2;
  }
  return { text: codeUnitsToString(units), droppedBytes: view.byteLength - offset };
}

/** Result of {@linkcode decodeUtf32}. */
export interface Utf32DecodeResult {
  text: string;
  /** Trailing bytes dropped because the range was not a multiple of four. */
  droppedBytes: number;
  /** Number of code units replaced with U+FFFD (surrogates / above U+10FFFF). */
  invalidUnits: number;
}

/** Decodes UTF-32LE/BE; invalid code units become U+FFFD and are counted. */
export function decodeUtf32(
  bytes: Uint8Array,
  littleEndian: boolean,
  start = 0,
  end = bytes.length,
): Utf32DecodeResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const codePoints: number[] = [];
  let invalidUnits = 0;
  let offset = 0;
  while (offset + 4 <= view.byteLength) {
    const codePoint = view.getUint32(offset, littleEndian);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      codePoints.push(0xfffd);
      invalidUnits++;
    } else {
      codePoints.push(codePoint);
    }
    offset += 4;
  }
  return {
    text: codePointsToString(codePoints),
    droppedBytes: view.byteLength - offset,
    invalidUnits,
  };
}
