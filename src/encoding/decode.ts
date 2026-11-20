/**
 * Decodes OFX bytes to text using the detected encoding, repairing the
 * encodings real Brazilian banks actually emit:
 *
 * - headers that declare `USASCII`/`1252` while the content is UTF-8
 *   (mojibake `Ã§` → repaired to `ç`, with a warning);
 * - headers that declare UTF-8 while the content is single-byte
 *   (repaired to windows-1252, with a warning);
 * - mixed files: single-byte content with embedded UTF-8 runs;
 * - ISO-8859-1 declarations whose 0x80..0x9F bytes are really windows-1252;
 * - unsupported or lying charset labels (fall back to heuristics, warn).
 */
import { byteOrderMarkLength, detectEncoding } from './detect.js';
import { decodeLatin1, decodeSingleByte, WINDOWS_1252 } from './tables.js';
import { decodeUtf16, decodeUtf32 } from './utf16.js';
import { decodeUtf8, findUtf8Runs, scanUtf8, type Utf8Run } from './utf8.js';
import type { EncodingDetection, EncodingName } from './types.js';
import type { ParseWarning } from '../types.js';

/** Warning codes emitted by this module. */
export type EncodingWarningCode =
  | 'mojibake-repaired'
  | 'charset-mismatch'
  | 'latin1-c1-repaired'
  | 'unsupported-charset'
  | 'truncated-utf16'
  | 'truncated-utf32'
  | 'invalid-utf32';

/** Result of {@linkcode decodeOfx}. */
export interface DecodeResult {
  /** Decoded text (BOM stripped, mojibake repaired). */
  text: string;
  /** Encoding actually used, which can differ from the detection after repair. */
  encoding: EncodingName;
  /** How the encoding was originally detected, including what the file declared. */
  detection: EncodingDetection;
  warnings: ParseWarning[];
}

function warn(code: EncodingWarningCode, message: string): ParseWarning {
  return { code, message };
}

/**
 * Decodes an OFX byte buffer to text.
 *
 * Never throws on malformed bytes; every repair is reported as a
 * {@linkcode ParseWarning} (encoding-level warnings carry no line/column
 * because they are about bytes, not decoded text).
 */
export function decodeOfx(bytes: Uint8Array): DecodeResult {
  const detection = detectEncoding(bytes);
  if (bytes.length === 0) {
    return { text: '', encoding: detection.encoding, detection, warnings: [] };
  }

  const warnings: ParseWarning[] = [];
  const start = detection.bom ? byteOrderMarkLength(bytes) : 0;
  const end = bytes.length;
  const declared = detection.declaredLabel;

  if (detection.declaredLabel !== undefined && detection.declaredEncoding === undefined) {
    warnings.push(
      warn(
        'unsupported-charset',
        `Declared charset '${detection.declaredLabel}' is not supported or does not match the bytes; decoded using content heuristics.`,
      ),
    );
  }

  switch (detection.encoding) {
    case 'utf-32le':
    case 'utf-32be': {
      const result = decodeUtf32(bytes, detection.encoding === 'utf-32le', start, end);
      if (result.droppedBytes > 0) {
        warnings.push(
          warn(
            'truncated-utf32',
            `Dropped ${result.droppedBytes} trailing byte(s) while decoding UTF-32.`,
          ),
        );
      }
      if (result.invalidUnits > 0) {
        warnings.push(
          warn(
            'invalid-utf32',
            `Replaced ${result.invalidUnits} invalid UTF-32 code unit(s) with U+FFFD.`,
          ),
        );
      }
      return { text: result.text, encoding: detection.encoding, detection, warnings };
    }

    case 'utf-16le':
    case 'utf-16be': {
      const result = decodeUtf16(bytes, detection.encoding === 'utf-16le', start, end);
      if (result.droppedBytes > 0) {
        warnings.push(
          warn(
            'truncated-utf16',
            `Dropped ${result.droppedBytes} trailing byte(s) while decoding UTF-16.`,
          ),
        );
      }
      return { text: result.text, encoding: detection.encoding, detection, warnings };
    }

    case 'utf-8': {
      const scan = scanUtf8(bytes, start, end);
      if (scan.valid) {
        return { text: decodeUtf8(bytes, start, end), encoding: 'utf-8', detection, warnings };
      }
      const runs = findUtf8Runs(bytes, start, end);
      if (runs.length > 0) {
        warnings.push(
          warn(
            'mojibake-repaired',
            `Content is not valid UTF-8 but contains ${runs.length} valid UTF-8 byte range(s); repaired them and decoded the rest as windows-1252.`,
          ),
        );
        return {
          text: decodeHybrid(bytes, start, end, runs),
          encoding: 'windows-1252',
          detection,
          warnings,
        };
      }
      warnings.push(
        warn('charset-mismatch', 'Content is not valid UTF-8; decoded as windows-1252.'),
      );
      return {
        text: decodeSingleByte(bytes, WINDOWS_1252, start, end),
        encoding: 'windows-1252',
        detection,
        warnings,
      };
    }

    case 'us-ascii':
    case 'windows-1252':
    case 'iso-8859-1': {
      const scan = scanUtf8(bytes, start, end);
      if (scan.valid && scan.multibyte > 0) {
        // The header lies: the content is actually UTF-8.
        warnings.push(
          warn(
            'mojibake-repaired',
            `Header declared '${declared ?? detection.encoding}' but the content is valid UTF-8; decoded as UTF-8.`,
          ),
        );
        return { text: decodeUtf8(bytes, start, end), encoding: 'utf-8', detection, warnings };
      }
      if (!scan.valid) {
        const runs = findUtf8Runs(bytes, start, end);
        if (runs.length > 0) {
          // Mixed file: single-byte content with embedded UTF-8 runs.
          warnings.push(
            warn(
              'mojibake-repaired',
              `Header declared '${declared ?? detection.encoding}' but ${runs.length} UTF-8 byte range(s) were found amid single-byte content; repaired them and decoded the rest as windows-1252.`,
            ),
          );
          return {
            text: decodeHybrid(bytes, start, end, runs),
            encoding: 'windows-1252',
            detection,
            warnings,
          };
        }
      }
      if (detection.encoding === 'iso-8859-1') {
        const result = decodeLatin1(bytes, start, end);
        if (result.repairedCount > 0) {
          warnings.push(
            warn(
              'latin1-c1-repaired',
              `Declared ISO-8859-1 contains ${result.repairedCount} byte(s) in 0x80-0x9F; mapped them using windows-1252.`,
            ),
          );
        }
        return { text: result.text, encoding: 'iso-8859-1', detection, warnings };
      }
      if (detection.encoding === 'us-ascii' && !scan.valid) {
        warnings.push(
          warn(
            'charset-mismatch',
            `Header declared US-ASCII but the content contains bytes above 0x7F; decoded as windows-1252.`,
          ),
        );
        return {
          text: decodeSingleByte(bytes, WINDOWS_1252, start, end),
          encoding: 'windows-1252',
          detection,
          warnings,
        };
      }
      return {
        text: decodeSingleByte(bytes, WINDOWS_1252, start, end),
        encoding: detection.encoding,
        detection,
        warnings,
      };
    }
  }
}

/**
 * Decodes a mixed file: UTF-8 runs as UTF-8, everything else as
 * windows-1252.
 */
function decodeHybrid(
  bytes: Uint8Array,
  start: number,
  end: number,
  runs: readonly Utf8Run[],
): string {
  let text = '';
  let cursor = start;
  for (const run of runs) {
    if (run.start > cursor) {
      text += decodeSingleByte(bytes, WINDOWS_1252, cursor, run.start);
    }
    text += decodeUtf8(bytes, run.start, run.end);
    cursor = run.end;
  }
  if (cursor < end) {
    text += decodeSingleByte(bytes, WINDOWS_1252, cursor, end);
  }
  return text;
}
