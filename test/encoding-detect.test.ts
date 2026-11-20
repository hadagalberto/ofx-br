import { describe, expect, it } from 'vitest';
import { byteOrderMarkLength, detectEncoding } from '../src/encoding/detect.js';
import {
  concatBytes,
  latin1Bytes,
  OFX1_HEADER_1252,
  OFX1_HEADER_ASCII,
  OFX2_HEADER,
  OFX_BODY,
  utf16Bytes,
  utf32Bytes,
  utf8Bytes,
} from './helpers.js';

describe('byteOrderMarkLength', () => {
  it('returns the length for each BOM flavour', () => {
    expect(byteOrderMarkLength(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe(3);
    expect(byteOrderMarkLength(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toBe(2);
    expect(byteOrderMarkLength(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]))).toBe(2);
    expect(byteOrderMarkLength(Uint8Array.from([0xff, 0xfe, 0x00, 0x00]))).toBe(4);
    expect(byteOrderMarkLength(Uint8Array.from([0x00, 0x00, 0xfe, 0xff]))).toBe(4);
  });

  it('returns 0 for buffers without a BOM', () => {
    expect(byteOrderMarkLength(utf8Bytes('OFXHEADER:100'))).toBe(0);
    expect(byteOrderMarkLength(Uint8Array.from([0x41]))).toBe(0);
    expect(byteOrderMarkLength(new Uint8Array(0))).toBe(0);
  });
});

describe('detectEncoding — empty input', () => {
  it('reports utf-8 with source empty', () => {
    expect(detectEncoding(new Uint8Array(0))).toEqual({
      encoding: 'utf-8',
      source: 'empty',
      bom: false,
    });
  });
});

describe('detectEncoding — byte-order marks', () => {
  const payload = OFX1_HEADER_1252 + OFX_BODY;

  it('trusts a UTF-8 BOM over the header declaration', () => {
    const bytes = concatBytes(Uint8Array.from([0xef, 0xbb, 0xbf]), utf8Bytes(payload));
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'utf-8',
      source: 'bom',
      bom: true,
      declaredLabel: '1252',
      declaredEncoding: 'windows-1252',
    });
  });

  it('trusts a UTF-16LE BOM', () => {
    const bytes = concatBytes(Uint8Array.from([0xff, 0xfe]), utf16Bytes(payload, true));
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-16le', source: 'bom', bom: true });
  });

  it('trusts a UTF-16BE BOM', () => {
    const bytes = concatBytes(Uint8Array.from([0xfe, 0xff]), utf16Bytes(payload, false));
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-16be', source: 'bom', bom: true });
  });

  it('prefers the UTF-32LE BOM over the UTF-16LE prefix', () => {
    const bytes = concatBytes(
      Uint8Array.from([0xff, 0xfe, 0x00, 0x00]),
      utf32Bytes('OFXHEADER:100\r\n', true),
    );
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-32le', source: 'bom', bom: true });
  });

  it('trusts a UTF-32BE BOM', () => {
    const bytes = concatBytes(
      Uint8Array.from([0x00, 0x00, 0xfe, 0xff]),
      utf32Bytes('OFXHEADER:100\r\n', false),
    );
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-32be', source: 'bom', bom: true });
  });

  it('does not confuse a UTF-16LE BOM followed by U+0000 with UTF-32', () => {
    // UTF-16LE "O" is 4F 00, followed by a NUL char (00 00): not a UTF-32 BOM.
    const bytes = concatBytes(Uint8Array.from([0xff, 0xfe]), utf16Bytes('O\0', true));
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-16le', source: 'bom', bom: true });
  });

  it('a bare UTF-8 BOM with garbage after it is still utf-8', () => {
    const bytes = concatBytes(Uint8Array.from([0xef, 0xbb, 0xbf]), Uint8Array.from([0xde, 0xad]));
    expect(detectEncoding(bytes).encoding).toBe('utf-8');
    expect(detectEncoding(bytes).source).toBe('bom');
  });

  it('handles a BOM-only file (no header window left to read)', () => {
    const detection = detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(detection).toEqual({ encoding: 'utf-8', source: 'bom', bom: true });
  });
});

describe('detectEncoding — BOM-less UTF-16 pattern', () => {
  it('recognizes NUL-interleaved ASCII as UTF-16LE', () => {
    const bytes = utf16Bytes('OFXHEADER:100\r\nDATA:OFXSGML\r\n', true);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'utf-16le',
      source: 'utf16-pattern',
      bom: false,
    });
  });

  it('recognizes NUL-interleaved ASCII as UTF-16BE', () => {
    const bytes = utf16Bytes('OFXHEADER:100\r\nDATA:OFXSGML\r\n', false);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'utf-16be',
      source: 'utf16-pattern',
      bom: false,
    });
  });

  it('does not mistake NUL-padded single-byte files for UTF-16', () => {
    // Plain ASCII text followed by NUL padding: no alternating pair pattern.
    const bytes = concatBytes(utf8Bytes('OFXHEADER:100\r\n'), new Uint8Array(40));
    expect(detectEncoding(bytes).source).not.toBe('utf16-pattern');
  });

  it('does not fire on very short inputs', () => {
    const bytes = utf16Bytes('OF', true);
    expect(detectEncoding(bytes).source).not.toBe('utf16-pattern');
  });
});

describe('detectEncoding — OFX 1.x header declarations', () => {
  it('honours CHARSET:1252 (the Itaú-style lie about US-ASCII)', () => {
    const bytes = utf8Bytes(OFX1_HEADER_1252 + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'windows-1252',
      source: 'ofx-header',
      bom: false,
      declaredLabel: '1252',
      declaredEncoding: 'windows-1252',
    });
  });

  it('honours ENCODING:USASCII with CHARSET:NONE', () => {
    const bytes = utf8Bytes(OFX1_HEADER_ASCII + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'us-ascii',
      source: 'ofx-header',
      bom: false,
      declaredLabel: 'USASCII',
      declaredEncoding: 'us-ascii',
    });
  });

  it('honours ENCODING:UTF-8 even when CHARSET contradicts it', () => {
    const header = ['OFXHEADER:100', 'ENCODING:UTF-8', 'CHARSET:1252', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'utf-8',
      source: 'ofx-header',
      bom: false,
      declaredLabel: 'UTF-8',
      declaredEncoding: 'utf-8',
    });
  });

  it('honours CHARSET:ISO-8859-1', () => {
    const header = ['OFXHEADER:100', 'ENCODING:USASCII', 'CHARSET:ISO-8859-1', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'iso-8859-1',
      source: 'ofx-header',
      bom: false,
      declaredLabel: 'ISO-8859-1',
      declaredEncoding: 'iso-8859-1',
    });
  });

  it('honours ENCODING:ISO-8859-1 when no CHARSET is given', () => {
    const header = ['OFXHEADER:100', 'ENCODING:ISO-8859-1', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    expect(detectEncoding(bytes).encoding).toBe('iso-8859-1');
    expect(detectEncoding(bytes).declaredLabel).toBe('ISO-8859-1');
  });

  it('reads lowercase keys', () => {
    const header = ['ofxheader:100', 'encoding:usascii', 'charset:1252', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'windows-1252',
      source: 'ofx-header',
      bom: false,
      declaredLabel: '1252',
      declaredEncoding: 'windows-1252',
    });
  });

  it('reads LF-only and CR-only headers', () => {
    const lf = utf8Bytes(
      ['OFXHEADER:100', 'ENCODING:USASCII', 'CHARSET:1252', '', '', OFX_BODY].join('\n'),
    );
    expect(detectEncoding(lf).encoding).toBe('windows-1252');
    const cr = utf8Bytes(
      ['OFXHEADER:100', 'ENCODING:USASCII', 'CHARSET:1252', '', '', OFX_BODY].join('\r'),
    );
    expect(detectEncoding(cr).encoding).toBe('windows-1252');
  });

  it('ignores body text after the header (CHARSET in a memo cannot leak)', () => {
    const bytes = utf8Bytes(`${OFX1_HEADER_1252}<OFX><MEMO>ENCODING:UTF-8</MEMO></OFX>`);
    expect(detectEncoding(bytes).encoding).toBe('windows-1252');
  });

  it('supports ISO-8859-1 label variants (ISO_8859-1, latin1)', () => {
    const headerA = ['OFXHEADER:100', 'CHARSET:ISO_8859-1', '', ''].join('\r\n');
    expect(detectEncoding(utf8Bytes(headerA + OFX_BODY)).encoding).toBe('iso-8859-1');
    const headerB = ['OFXHEADER:100', 'CHARSET:latin1', '', ''].join('\r\n');
    expect(detectEncoding(utf8Bytes(headerB + OFX_BODY)).encoding).toBe('iso-8859-1');
  });

  it('records an unknown charset label and falls back to heuristics', () => {
    const header = ['OFXHEADER:100', 'CHARSET:X-PT-BR-9', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe('utf-8'); // valid UTF-8 heuristic
    expect(detection.source).toBe('utf8-heuristic');
    expect(detection.declaredLabel).toBe('X-PT-BR-9');
    expect(detection.declaredEncoding).toBeUndefined();
  });

  it('records an unknown ENCODING label when no CHARSET is given', () => {
    const header = ['OFXHEADER:100', 'ENCODING:X-WEIRD-9', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe('utf-8'); // heuristic: valid UTF-8 (pure ASCII)
    expect(detection.source).toBe('utf8-heuristic');
    expect(detection.declaredLabel).toBe('X-WEIRD-9');
    expect(detection.declaredEncoding).toBeUndefined();
  });

  it('treats ENCODING:NONE as no declaration at all', () => {
    const header = ['OFXHEADER:100', 'ENCODING:NONE', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + OFX_BODY);
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe('utf-8');
    expect(detection.source).toBe('utf8-heuristic');
    expect(detection.declaredLabel).toBeUndefined();
  });

  it('handles a single-byte file', () => {
    expect(detectEncoding(Uint8Array.from([0x41]))).toEqual({
      encoding: 'utf-8',
      source: 'utf8-heuristic',
      bom: false,
    });
  });

  it('handles a truncated header (declares nothing usable)', () => {
    const bytes = utf8Bytes('OFXHEADER:1');
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe('utf-8');
    expect(detection.source).toBe('utf8-heuristic');
    expect(detection.declaredLabel).toBeUndefined();
  });

  it('handles headers containing NUL bytes between lines', () => {
    const header = 'OFXHEADER:100\r\n\0\0ENCODING:USASCII\r\nCHARSET:1252\r\n\r\n';
    const bytes = utf8Bytes(header + OFX_BODY);
    expect(detectEncoding(bytes).encoding).toBe('windows-1252');
  });

  it('handles high bytes in the header area by dropping the broken line', () => {
    // Broken export: accented bytes inside what should be an ASCII header.
    // Lines before the corruption still declare ENCODING:USASCII.
    const bytes = concatBytes(
      utf8Bytes('OFXHEADER:100\r\nENCODING:USASCII\r\nCHARSET'),
      Uint8Array.from([0xe7]),
      utf8Bytes(':1252\r\n\r\n<OFX>'),
    );
    const detection = detectEncoding(bytes);
    expect(detection.source).toBe('ofx-header');
    expect(detection.encoding).toBe('us-ascii');
    expect(detection.declaredLabel).toBe('USASCII');
  });
});

describe('detectEncoding — OFX 2.x headers', () => {
  it('honours the XML prolog encoding', () => {
    const bytes = utf8Bytes(OFX2_HEADER + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'utf-8',
      source: 'xml-prolog',
      bom: false,
      declaredLabel: 'UTF-8',
      declaredEncoding: 'utf-8',
    });
  });

  it('parses the OFX processing instruction before the prolog', () => {
    const bytes = utf8Bytes(
      '<?OFX OFXHEADER="200" VERSION="203"?><?xml version="1.0" encoding="ISO-8859-1"?>' + OFX_BODY,
    );
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'iso-8859-1',
      source: 'xml-prolog',
      bom: false,
      declaredLabel: 'ISO-8859-1',
      declaredEncoding: 'iso-8859-1',
    });
  });

  it('handles the XML prolog appearing first', () => {
    const bytes = utf8Bytes(
      '<?xml version="1.0" encoding="windows-1252"?><?OFX OFXHEADER="200"?>' + OFX_BODY,
    );
    expect(detectEncoding(bytes).encoding).toBe('windows-1252');
    expect(detectEncoding(bytes).source).toBe('xml-prolog');
  });

  it('honours single-quoted prolog attributes', () => {
    const bytes = utf8Bytes(`<?xml version='1.0' encoding='ISO-8859-1'?>` + OFX_BODY);
    expect(detectEncoding(bytes).encoding).toBe('iso-8859-1');
  });

  it('reads a CHARSET attribute inside the OFX processing instruction', () => {
    const bytes = utf8Bytes('<?OFX OFXHEADER="200" CHARSET="1252"?>' + OFX_BODY);
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'windows-1252',
      source: 'ofx-header',
      bom: false,
      declaredLabel: '1252',
      declaredEncoding: 'windows-1252',
    });
  });

  it('without a usable declaration, falls back to the UTF-8 heuristic', () => {
    const bytes = utf8Bytes('<?OFX OFXHEADER="200" VERSION="203"?>' + OFX_BODY);
    expect(detectEncoding(bytes).encoding).toBe('utf-8');
    expect(detectEncoding(bytes).source).toBe('utf8-heuristic');
  });

  it('does not trust a UTF-16 prolog declaration on plainly single-byte content', () => {
    const bytes = utf8Bytes(`<?xml version="1.0" encoding="UTF-16"?>` + OFX_BODY);
    const detection = detectEncoding(bytes);
    expect(detection.encoding).toBe('utf-8'); // heuristic: valid UTF-8 (pure ASCII)
    expect(detection.declaredLabel).toBe('UTF-16');
    expect(detection.declaredEncoding).toBeUndefined();
  });
});

describe('detectEncoding — heuristics', () => {
  it('valid UTF-8 without any header is detected as UTF-8', () => {
    const bytes = utf8Bytes('São Paulo — ação é fácil');
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'utf-8',
      source: 'utf8-heuristic',
      bom: false,
    });
  });

  it('pure ASCII without any header is detected as UTF-8 (ASCII is a subset)', () => {
    const bytes = utf8Bytes('no header here, just text');
    expect(detectEncoding(bytes).encoding).toBe('utf-8');
    expect(detectEncoding(bytes).source).toBe('utf8-heuristic');
  });

  it('invalid UTF-8 without any header falls back to windows-1252', () => {
    const bytes = latin1Bytes('São çã éíóú');
    expect(detectEncoding(bytes)).toEqual({
      encoding: 'windows-1252',
      source: 'fallback',
      bom: false,
    });
  });

  it('binary garbage falls back to windows-1252', () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    expect(detectEncoding(bytes).encoding).toBe('windows-1252');
    expect(detectEncoding(bytes).source).toBe('fallback');
  });

  it('a body starting directly with <OFX> (no header) uses heuristics', () => {
    const bytes = utf8Bytes(OFX_BODY);
    expect(detectEncoding(bytes).source).toBe('utf8-heuristic');
  });
});
