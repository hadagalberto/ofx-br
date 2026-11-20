import { describe, expect, it } from 'vitest';
import { TextDecoder } from 'node:util';
import {
  WINDOWS_1252,
  ISO_8859_1,
  codeUnitsToString,
  decodeSingleByte,
  decodeLatin1,
} from '../src/encoding/tables.js';
import { decodeUtf8, findUtf8Runs, scanUtf8, Utf8DecodeError } from '../src/encoding/utf8.js';
import { decodeUtf16, decodeUtf32 } from '../src/encoding/utf16.js';
import {
  concatBytes,
  cp1252Bytes,
  latin1Bytes,
  utf8Bytes,
  utf16Bytes,
  utf32Bytes,
} from './helpers.js';

/** All byte values 0..255 in order. */
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

/**
 * Hard-coded WHATWG windows-1252 index for bytes 0x80–0x9F, transcribed from
 * the Encoding Standard's index file:
 *   https://encoding.spec.whatwg.org/index-windows-1252.txt
 * Unassigned slots keep their C1 controls (U+0081/U+008D/U+008F/U+0090/U+009D).
 * The main assertions below use these code points directly — never the
 * runtime's TextDecoder, whose ICU backing differs across Node builds/OSes.
 */
const WHATWG_WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Bytes where true ISO-8859-1 (identity) differs from WHATWG's `iso-8859-1` label (a windows-1252 alias). */
const EXPECTED_LATIN1_ALIAS_DIVERGENCE: readonly number[] = [
  0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93,
  0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f,
];

/** Expected decoded string for all 256 bytes, from the hard-coded WHATWG table. */
function expectedTableString(high: readonly number[]): string {
  let out = '';
  for (let b = 0; b < 256; b++) {
    out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? (high[b - 0x80] ?? b) : b);
  }
  return out;
}

/** Expected decode of ALL_BYTES under windows-1252, independent of any runtime. */
const EXPECTED_WINDOWS_1252_ALL_BYTES = expectedTableString(WHATWG_WINDOWS_1252_HIGH);

/** A >8 KiB payload whose bytes cross the decoder's internal chunk boundaries. */
const CHUNK_PATTERN = Array.from({ length: 9000 }, (_, i) => i % 256);

type DecoderProbe = readonly [readonly number[], string];

/** Returns a decoder only when it exists AND matches the WHATWG probes below. */
function whatwgDecoder(label: string, probes: readonly DecoderProbe[]): TextDecoder | undefined {
  if (typeof TextDecoder === 'undefined') {
    return undefined;
  }
  try {
    const decoder = new TextDecoder(label);
    for (const [bytes, expected] of probes) {
      if (decoder.decode(Uint8Array.from(bytes)) !== expected) {
        return undefined;
      }
    }
    return decoder;
  } catch {
    return undefined;
  }
}

// Probe unassigned C1 slots too: a runtime that implements real ISO-8859-1
// under the `iso-8859-1` label fails at 0x80 and is correctly skipped.
const WINDOWS_1252_PROBES: readonly DecoderProbe[] = [
  [[0x80], '\u20ac'],
  [[0x81], '\u0081'],
  [[0x8c], '\u0152'],
  [[0x9d], '\u009d'],
  [[0x9f], '\u0178'],
];
const windows1252Oracle = whatwgDecoder('windows-1252', WINDOWS_1252_PROBES);
const latin1AliasOracle = whatwgDecoder('iso-8859-1', WINDOWS_1252_PROBES);
const utf8Oracle = whatwgDecoder('utf-8', [
  [[0xc3, 0xa7], '\u00e7'],
  [[0xe2, 0x82, 0xac], '\u20ac'],
]);

/**
 * Registers an OPTIONAL cross-check. When the runtime decoder is missing or
 * non-conformant we skip only this one test, log the reason, and leave the
 * hard-coded assertions (which always run) as the source of truth.
 */
function crossCheck(
  name: string,
  oracle: TextDecoder | undefined,
  check: (decoder: TextDecoder) => void,
): void {
  if (oracle === undefined) {
    console.log(
      `[encoding-tables] skipped ${name}: runtime TextDecoder is unavailable or not WHATWG-compliant; hard-coded assertions still ran.`,
    );
  }
  it.skipIf(oracle === undefined)(name, () => {
    if (oracle !== undefined) {
      check(oracle);
    }
  });
}

describe('windows-1252 table', () => {
  it('decodes 0x00-0x7F and 0xA0-0xFF as identity', () => {
    for (const b of [...ALL_BYTES]) {
      if (b <= 0x7f || b >= 0xa0) {
        expect(WINDOWS_1252[b]).toBe(b);
      }
    }
  });

  it('maps every 0x80-0x9F byte to its hard-coded WHATWG code point', () => {
    for (let i = 0; i < WHATWG_WINDOWS_1252_HIGH.length; i++) {
      expect(WINDOWS_1252[0x80 + i]).toBe(WHATWG_WINDOWS_1252_HIGH[i]);
    }
    for (const b of [0x7f, 0xa9, 0xe9, 0xff]) {
      expect(WINDOWS_1252[b]).toBe(b); // identity outside the high range
    }
  });

  it('decodes every byte value to the hard-coded WHATWG code points', () => {
    expect(decodeSingleByte(ALL_BYTES, WINDOWS_1252)).toBe(EXPECTED_WINDOWS_1252_ALL_BYTES);
  });

  crossCheck(
    'cross-checks all bytes with a WHATWG-compliant TextDecoder',
    windows1252Oracle,
    (d) => {
      expect(decodeSingleByte(ALL_BYTES, WINDOWS_1252)).toBe(d.decode(ALL_BYTES));
    },
  );

  it('decodes a Brazilian windows-1252 payload correctly', () => {
    const text = 'Ação é fácil — não há ção, R$ 1.234,56 … “ok”';
    expect(decodeSingleByte(cp1252Bytes(text), WINDOWS_1252)).toBe(text);
  });
});

describe('ISO-8859-1 table', () => {
  it('is the identity table for all 256 bytes', () => {
    for (const b of [...ALL_BYTES]) {
      expect(ISO_8859_1[b]).toBe(b);
    }
  });

  it('diverges from the WHATWG iso-8859-1 label exactly at the 27 mapped 0x80-0x9F positions', () => {
    // WHATWG maps the `iso-8859-1` label to windows-1252, so its decoded text
    // differs from true (identity) ISO-8859-1 at every high byte except the
    // five unassigned slots. Expected positions are hard-coded above.
    const diverging: number[] = [];
    for (let b = 0; b < 256; b++) {
      const whatwg = b >= 0x80 && b <= 0x9f ? (WHATWG_WINDOWS_1252_HIGH[b - 0x80] ?? b) : b;
      if ((ISO_8859_1[b] ?? b) !== whatwg) {
        diverging.push(b);
      }
    }
    expect(diverging).toEqual(EXPECTED_LATIN1_ALIAS_DIVERGENCE);
  });

  crossCheck(
    'cross-checks the iso-8859-1 alias divergence with TextDecoder',
    latin1AliasOracle,
    (d) => {
      const mine = decodeSingleByte(ALL_BYTES, ISO_8859_1);
      const theirs = d.decode(ALL_BYTES);
      const diverging: number[] = [];
      for (let b = 0; b < 256; b++) {
        if (mine[b] !== theirs[b]) {
          diverging.push(b);
        }
      }
      expect(diverging).toEqual(EXPECTED_LATIN1_ALIAS_DIVERGENCE);
    },
  );

  it('decodeLatin1 repairs 0x80-0x9F bytes via windows-1252 and counts them', () => {
    // "R$" + 0x97 (windows-1252 em dash) + " 100" + 0xE9 (é, identity in latin1).
    const bytes = concatBytes(latin1Bytes('R$ '), Uint8Array.from([0x97]), latin1Bytes(' 100é'));
    const result = decodeLatin1(bytes);
    expect(result.text).toBe('R$ — 100é');
    expect(result.repairedCount).toBe(1);
  });

  it('decodeLatin1 leaves genuine latin1 text untouched', () => {
    const bytes = latin1Bytes('Café ção Àà Ââ');
    const result = decodeLatin1(bytes);
    expect(result.text).toBe('Café ção Àà Ââ');
    expect(result.repairedCount).toBe(0);
  });
});

describe('codeUnitsToString chunking', () => {
  it('round-trips payloads larger than the internal chunk size', () => {
    const units = Array.from({ length: 9000 }, (_, i) => i % 256);
    // Identity table for units < 0x100.
    const expected = String.fromCharCode(...units);
    expect(codeUnitsToString(units)).toBe(expected);
  });
});

describe('decodeSingleByte', () => {
  it('decodes a payload crossing chunk boundaries byte-for-byte', () => {
    const bytes = Uint8Array.from(CHUNK_PATTERN);
    const expected = CHUNK_PATTERN.map((b) => EXPECTED_WINDOWS_1252_ALL_BYTES[b] ?? '').join('');
    expect(decodeSingleByte(bytes, WINDOWS_1252)).toBe(expected);
  });

  crossCheck(
    'cross-checks chunk-boundary decoding with a WHATWG-compliant TextDecoder',
    windows1252Oracle,
    (d) => {
      const bytes = Uint8Array.from(CHUNK_PATTERN);
      expect(decodeSingleByte(bytes, WINDOWS_1252)).toBe(d.decode(bytes));
    },
  );

  it('honours start and end bounds', () => {
    const bytes = latin1Bytes('abcdef');
    expect(decodeSingleByte(bytes, WINDOWS_1252, 1, 4)).toBe('bcd');
  });
});

describe('scanUtf8', () => {
  it('accepts pure ASCII with no multibyte sequences', () => {
    expect(scanUtf8(utf8Bytes('plain ascii text'))).toEqual({
      valid: true,
      multibyte: 0,
      firstInvalidOffset: undefined,
    });
  });

  it('accepts valid multi-byte text and counts sequences', () => {
    expect(scanUtf8(utf8Bytes('aãé😀'))).toEqual({
      valid: true,
      multibyte: 3,
      firstInvalidOffset: undefined,
    });
  });

  it('accepts an empty range', () => {
    expect(scanUtf8(new Uint8Array(0))).toEqual({
      valid: true,
      multibyte: 0,
      firstInvalidOffset: undefined,
    });
  });

  it('accepts NUL bytes as valid 1-byte sequences', () => {
    const bytes = Uint8Array.from([0x00, 0x41, 0x00, 0x42]);
    expect(scanUtf8(bytes).valid).toBe(true);
  });

  const invalidVectors: [string, number[], number][] = [
    ['lone continuation byte', [0x80], 0],
    ['second lone continuation', [0x41, 0xbf], 1],
    ['overlong 2-byte lead 0xC0', [0xc0, 0xaf], 0],
    ['overlong 2-byte lead 0xC1', [0xc1, 0xbf], 0],
    ['truncated 2-byte at EOF', [0x41, 0xc3], 1],
    ['bad 2-byte continuation (ASCII)', [0x41, 0xc3, 0x41], 1],
    ['overlong 3-byte E0 80 80', [0xe0, 0x80, 0x80], 0],
    ['E0 with continuation below 0xA0', [0xe0, 0x9f, 0x80], 0],
    ['truncated 3-byte at EOF', [0xe1, 0x80], 0],
    ['UTF-16 surrogate half ED A0 80', [0xed, 0xa0, 0x80], 0],
    ['ED with continuation above 0x9F', [0xed, 0xbf, 0xbf], 0],
    ['overlong 4-byte F0 8F BF BF', [0xf0, 0x8f, 0xbf, 0xbf], 0],
    ['F0 with continuation below 0x90', [0xf0, 0x8f, 0x80, 0x80], 0],
    ['4-byte F0 with bad 2nd continuation', [0xf0, 0x90, 0x41, 0x80], 0],
    ['truncated 4-byte F1 at EOF', [0xf1, 0x80, 0x80], 0],
    ['3-byte E1 with bad first continuation', [0xe1, 0x41, 0x80], 0],
    ['truncated E0 lead alone', [0xe0], 0],
    ['E0 with valid first continuation but bad second', [0xe0, 0xa0, 0x41], 0],
    ['4-byte F0 with bad 3rd continuation', [0xf0, 0x90, 0x80, 0x41], 0],
    ['4-byte F1 with bad 2nd continuation', [0xf1, 0x80, 0x41, 0x80], 0],
    ['4-byte F4 with bad 3rd continuation', [0xf4, 0x80, 0x80, 0x41], 0],
    ['code point above U+10FFFF F4 90 80 80', [0xf4, 0x90, 0x80, 0x80], 0],
    ['4-byte F4 with bad 2nd continuation', [0xf4, 0x8f, 0x41], 0],
    ['reserved lead 0xF5', [0xf5, 0x80, 0x80, 0x80], 0],
    ['reserved lead 0xFF', [0xff, 0xfe], 0],
    ['latin1 ç after valid prefix', [0x61, 0x62, 0xe7, 0x20], 2],
  ];

  it.each(invalidVectors)('rejects %s at the exact offset', (_name, bytes, offset) => {
    const scan = scanUtf8(Uint8Array.from(bytes));
    expect(scan.valid).toBe(false);
    expect(scan.firstInvalidOffset).toBe(offset);
  });

  it('reports multibyte count accumulated before the invalid byte', () => {
    // "ã" (C3 A3) valid, then "é" raw (E9) invalid.
    const scan = scanUtf8(Uint8Array.from([0xc3, 0xa3, 0xe9]));
    expect(scan.valid).toBe(false);
    expect(scan.multibyte).toBe(1);
    expect(scan.firstInvalidOffset).toBe(2);
  });

  const validLeadVectors: [string, number[], string][] = [
    ['valid ED lower half U+D000', [0xed, 0x80, 0x80], '\u{d000}'],
    ['valid F1 code point U+40000', [0xf1, 0x80, 0x80, 0x80], '\u{40000}'],
    ['valid F4 code point U+10FFFF', [0xf4, 0x8f, 0xbf, 0xbf], '\u{10ffff}'],
    ['valid E0 code point U+0800', [0xe0, 0xa0, 0x80], '\u{800}'],
    ['valid EE code point U+E000', [0xee, 0x80, 0x80], '\u{e000}'],
  ];

  it.each(validLeadVectors)('accepts %s', (_name, bytes, expected) => {
    const scan = scanUtf8(Uint8Array.from(bytes));
    expect(scan.valid).toBe(true);
    expect(scan.multibyte).toBe(1);
    expect(decodeUtf8(Uint8Array.from(bytes))).toBe(expected);
  });
});

describe('decodeUtf8', () => {
  const roundTripVectors = [
    'plain ascii',
    'Ação é fácil — não dá ção',
    'Ünïcödé wörd: 42%',
    '日本文 — 東京タワー',
    'emoji: 😀 🇧🇷 👨‍👩‍👧‍👦',
    'control \u0000 byte inside',
  ];

  it.each(roundTripVectors)('round-trips %s to the original text', (text) => {
    expect(decodeUtf8(utf8Bytes(text))).toBe(text);
  });

  crossCheck(
    'cross-checks UTF-8 round-trips with a WHATWG-compliant TextDecoder',
    utf8Oracle,
    (d) => {
      for (const text of roundTripVectors) {
        expect(decodeUtf8(utf8Bytes(text))).toBe(d.decode(utf8Bytes(text)));
      }
    },
  );

  it('round-trips a payload crossing chunk boundaries', () => {
    const text = 'é'.repeat(9000);
    expect(decodeUtf8(utf8Bytes(text))).toBe(text);
  });

  it('honours start and end bounds', () => {
    const bytes = utf8Bytes('aébc');
    expect(decodeUtf8(bytes, 1, 3)).toBe('é');
  });

  it('throws Utf8DecodeError on invalid input', () => {
    const bytes = Uint8Array.from([0x41, 0xe9, 0x42]);
    expect(() => decodeUtf8(bytes)).toThrow(Utf8DecodeError);
    try {
      decodeUtf8(bytes);
    } catch (error) {
      expect((error as Utf8DecodeError).offset).toBe(1);
    }
  });
});

describe('findUtf8Runs', () => {
  it('returns nothing for pure ASCII', () => {
    expect(findUtf8Runs(utf8Bytes('abc def'))).toEqual([]);
  });

  it('returns a single run for fully valid multibyte text', () => {
    const bytes = utf8Bytes('abcédef');
    expect(findUtf8Runs(bytes)).toEqual([{ start: 0, end: bytes.length }]);
  });

  it('finds runs around a lone windows-1252 byte', () => {
    // "abc" + é(UTF-8) + "def" + ç(latin1 0xE7) + "ghi" + 😀(UTF-8) + "jkl"
    const bytes = concatBytes(
      utf8Bytes('abc'),
      utf8Bytes('é'),
      utf8Bytes('def'),
      Uint8Array.from([0xe7]),
      utf8Bytes('ghi'),
      utf8Bytes('😀'),
      utf8Bytes('jkl'),
    );
    expect(findUtf8Runs(bytes)).toEqual([
      { start: 0, end: 8 },
      { start: 9, end: 19 },
    ]);
  });

  it('ignores stretches without any multibyte sequence', () => {
    // "abc" + lone 0xE7 + "def": the first stretch is ASCII-only.
    const bytes = concatBytes(utf8Bytes('abc'), Uint8Array.from([0xe7]), utf8Bytes('def'));
    expect(findUtf8Runs(bytes)).toEqual([]);
  });

  it('ignores a truncated sequence at EOF', () => {
    const bytes = concatBytes(utf8Bytes('abc'), Uint8Array.from([0xc3]));
    expect(findUtf8Runs(bytes)).toEqual([]);
  });
});

describe('decodeUtf16', () => {
  it('round-trips LE and BE text including surrogate pairs', () => {
    const text = 'OFXHEADER:100 Ação 😀';
    expect(decodeUtf16(utf16Bytes(text, true), true).text).toBe(text);
    expect(decodeUtf16(utf16Bytes(text, false), false).text).toBe(text);
  });

  it('reports a dropped trailing odd byte', () => {
    const bytes = concatBytes(utf16Bytes('AB', true), Uint8Array.from([0x41]));
    const result = decodeUtf16(bytes, true);
    expect(result.text).toBe('AB');
    expect(result.droppedBytes).toBe(1);
  });

  it('handles an empty range', () => {
    expect(decodeUtf16(new Uint8Array(0), true)).toEqual({
      text: '',
      droppedBytes: 0,
    });
  });
});

describe('decodeUtf32', () => {
  it('round-trips LE and BE text', () => {
    const text = 'OFXHEADER:100 Ação';
    expect(decodeUtf32(utf32Bytes(text, true), true).text).toBe(text);
    expect(decodeUtf32(utf32Bytes(text, false), false).text).toBe(text);
  });

  it('replaces invalid code units with U+FFFD and counts them', () => {
    // LE 0x00110000 (above U+10FFFF) and LE 0xD800 (surrogate half).
    const bytes = concatBytes(
      Uint8Array.from([0x00, 0x00, 0x11, 0x00]),
      Uint8Array.from([0x00, 0xd8, 0x00, 0x00]),
      utf32Bytes('A', true),
    );
    const result = decodeUtf32(bytes, true);
    expect(result.text).toBe('\ufffd\ufffdA');
    expect(result.invalidUnits).toBe(2);
    expect(result.droppedBytes).toBe(0);
  });

  it('drops trailing partial code units', () => {
    const bytes = concatBytes(utf32Bytes('A', true), Uint8Array.from([0x41, 0x42]));
    const result = decodeUtf32(bytes, true);
    expect(result.text).toBe('A');
    expect(result.droppedBytes).toBe(2);
  });
});
