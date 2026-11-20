/** Byte builders for encoding test vectors. */
import { TextEncoder } from 'node:util';

import { WINDOWS_1252 } from '../src/encoding/tables.js';

const encoder = new TextEncoder();

/** Inverse of the windows-1252 table: code unit → byte. */
const CP1252_REVERSE = new Map<number, number>();
for (let b = 0; b < 256; b++) {
  const unit = WINDOWS_1252[b];
  if (unit !== undefined) {
    CP1252_REVERSE.set(unit, b);
  }
}

/** UTF-8 bytes (throws on lone surrogates, which is what the tests want). */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Bytes for a text whose chars are all ≤ U+00FF (ISO-8859-1 payloads). */
export function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(`latin1Bytes: char ${JSON.stringify(text[i])} exceeds U+00FF`);
    }
    bytes[i] = code;
  }
  return bytes;
}

/** Windows-1252 bytes for arbitrary text (chars must exist in the table). */
export function cp1252Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const mapped = CP1252_REVERSE.get(code);
    if (mapped === undefined) {
      throw new Error(`cp1252Bytes: char ${JSON.stringify(text[i])} is not in windows-1252`);
    }
    bytes[i] = mapped;
  }
  return bytes;
}

/** UTF-16 bytes for `text` (no surrogate validation — round-trip is asserted by callers). */
export function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (littleEndian) {
      bytes[i * 2] = code & 0xff;
      bytes[i * 2 + 1] = code >> 8;
    } else {
      bytes[i * 2] = code >> 8;
      bytes[i * 2 + 1] = code & 0xff;
    }
  }
  return bytes;
}

/** UTF-32 bytes for `text` (chars must be ≤ U+FFFF unless they are pairs of surrogates). */
export function utf32Bytes(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 4);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const offset = i * 4;
    if (littleEndian) {
      bytes[offset] = code & 0xff;
      bytes[offset + 1] = (code >> 8) & 0xff;
      bytes[offset + 2] = (code >> 16) & 0xff;
      bytes[offset + 3] = (code >> 24) & 0xff;
    } else {
      bytes[offset] = (code >> 24) & 0xff;
      bytes[offset + 1] = (code >> 16) & 0xff;
      bytes[offset + 2] = (code >> 8) & 0xff;
      bytes[offset + 3] = code & 0xff;
    }
  }
  return bytes;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * True when Vitest runs with coverage instrumentation. Instrumented timing
 * measures the profiler (a 2-4× slowdown), so performance tests relax their
 * bound here and keep the strict bound for plain runs.
 */
export function isCoverageRun(): boolean {
  interface VitestWorkerLike {
    config?: { coverage?: { enabled?: boolean } };
  }
  const globalWithWorker = globalThis as typeof globalThis & {
    __vitest_worker__?: VitestWorkerLike;
  };
  return globalWithWorker.__vitest_worker__?.config?.coverage?.enabled === true;
}

/** Canonical OFX 1.x header, Itaú-style (the most common Brazilian shape). */
export const OFX1_HEADER_1252 = [
  'OFXHEADER:100',
  'DATA:OFXSGML',
  'VERSION:102',
  'SECURITY:NONE',
  'ENCODING:USASCII',
  'CHARSET:1252',
  'COMPRESSION:NONE',
  'OLDFILEUID:NONE',
  'NEWFILEUID:NONE',
  '',
  '',
].join('\r\n');

/** OFX 1.x header that declares US-ASCII honestly. */
export const OFX1_HEADER_ASCII = [
  'OFXHEADER:100',
  'DATA:OFXSGML',
  'VERSION:102',
  'ENCODING:USASCII',
  'CHARSET:NONE',
  '',
  '',
].join('\r\n');

/** Canonical OFX 2.x header (processing instruction + XML prolog). */
export const OFX2_HEADER =
  '<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="none"?>' +
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';

export const OFX_BODY = '<OFX><SIGNONMSGSRSV1><SONRS>...</SONRS></SIGNONMSGSRSV1></OFX>';

/** Wraps body text with a 1.x header and CRLF separator. */
export function ofx1File(header: string, body: string): string {
  return `${header}${body}`;
}
