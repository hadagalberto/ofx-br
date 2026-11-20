import { describe, expect, it } from 'vitest';
import { OfxParseError, parseOfxHeader } from '../src/index.js';
import { OFX1_HEADER_1252, OFX2_HEADER, OFX_BODY } from './helpers.js';

describe('parseOfxHeader — OFX 1.x key:value', () => {
  it('parses a canonical CRLF header and stops at the body', () => {
    const text = OFX1_HEADER_1252 + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({
      OFXHEADER: '100',
      DATA: 'OFXSGML',
      VERSION: '102',
      SECURITY: 'NONE',
      ENCODING: 'USASCII',
      CHARSET: '1252',
      COMPRESSION: 'NONE',
      OLDFILEUID: 'NONE',
      NEWFILEUID: 'NONE',
    });
    expect(result.version).toBe('1');
    expect(result.warnings).toEqual([]);
    expect(result.endOffset).toBe(OFX1_HEADER_1252.length);
    expect(text[result.endOffset]).toBe('<');
  });

  it('parses LF-only and CR-only headers', () => {
    const lf = ['OFXHEADER:100', 'VERSION:103', '', '', OFX_BODY].join('\n');
    expect(parseOfxHeader(lf).header.VERSION).toBe('103');
    const cr = ['OFXHEADER:100', 'VERSION:103', '', '', OFX_BODY].join('\r');
    expect(parseOfxHeader(cr).header.VERSION).toBe('103');
  });

  it('uppercases keys and trims values', () => {
    const text = 'ofxheader:100\r\ndata:  OFXSGML  \r\n\r\n' + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('100');
    expect(result.header.DATA).toBe('OFXSGML');
  });

  it('tolerates the blank line before the body being missing', () => {
    const text = 'OFXHEADER:100\r\nVERSION:102\r\n' + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.VERSION).toBe('102');
    expect(text[result.endOffset]).toBe('<');
  });

  it('keeps the last value on duplicate keys', () => {
    const text = 'OFXHEADER:100\r\nNEWFILEUID:ONE\r\nNEWFILEUID:TWO\r\n\r\n' + OFX_BODY;
    expect(parseOfxHeader(text).header.NEWFILEUID).toBe('TWO');
  });

  it('values may contain colons and spaces (only the first colon splits)', () => {
    const text = 'OFXHEADER:100\r\nCOMMENT:key: with spaces\r\n\r\n' + OFX_BODY;
    expect(parseOfxHeader(text).header.COMMENT).toBe('key: with spaces');
  });

  it('splits concatenated one-line headers at KEY: boundaries', () => {
    const text = 'OFXHEADER:100ENCODING:USASCIICHARSET:1252' + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({
      OFXHEADER: '100',
      ENCODING: 'USASCII',
      CHARSET: '1252',
    });
    expect(result.version).toBe('1');
    expect(text[result.endOffset]).toBe('<');
  });

  it('does not split values at lowercase word-colon patterns', () => {
    const text = 'OFXHEADER:100\r\nNOTE:http://example.com\r\n\r\n' + OFX_BODY;
    expect(parseOfxHeader(text).header.NOTE).toBe('http://example.com');
  });

  it('skips NUL bytes between header lines', () => {
    const text = 'OFXHEADER:100\r\n\0\0VERSION:102\r\n\r\n' + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.VERSION).toBe('102');
    expect(result.warnings).toEqual([]);
  });

  it('stops the header at the first unrecognized line', () => {
    const text = 'OFXHEADER:100\r\nTHIS IS GARBAGE\r\nVERSION:102\r\n\r\n' + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({ OFXHEADER: '100' });
    expect(result.warnings).toEqual([]);
  });

  it('accepts keys with digits, hyphens and underscores', () => {
    const text = 'OFXHEADER:100\r\nX-CUSTOM_KEY-2:value\r\n\r\n' + OFX_BODY;
    expect(parseOfxHeader(text).header['X-CUSTOM_KEY-2']).toBe('value');
  });

  it('treats a word without a colon as the end of the header', () => {
    const text = 'OFXHEADER:100\r\nGARBAGE\r\n' + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({ OFXHEADER: '100' });
    expect(result.version).toBe('1');
  });
});

describe('parseOfxHeader — version detection', () => {
  const versions: [string, '1' | '2' | 'unknown'][] = [
    ['100', '1'],
    ['102', '1'],
    ['103', '1'],
    ['151', '1'],
    ['160', '1'],
    ['200', '2'],
    ['201', '2'],
    ['202', '2'],
    ['203', '2'],
    ['220', '2'],
    ['xyz', 'unknown'],
    ['', 'unknown'],
  ];

  it.each(versions)('OFXHEADER:%s → %s', (value, expected) => {
    const text = `OFXHEADER:${value}\r\n\r\n` + OFX_BODY;
    expect(parseOfxHeader(text).version).toBe(expected);
  });

  it('falls back to VERSION when OFXHEADER is absent', () => {
    const text = 'VERSION:102\r\n\r\n' + OFX_BODY;
    expect(parseOfxHeader(text).version).toBe('1');
  });

  it('reports unknown when neither OFXHEADER nor VERSION exists', () => {
    const text = 'SECURITY:NONE\r\n\r\n' + OFX_BODY;
    expect(parseOfxHeader(text).version).toBe('unknown');
  });
});

describe('parseOfxHeader — OFX 2.x processing instructions', () => {
  it('parses the OFX PI and the XML prolog', () => {
    const text = OFX2_HEADER + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({
      OFXHEADER: '200',
      VERSION: '200',
      SECURITY: 'NONE',
      OLDFILEUID: 'NONE',
      NEWFILEUID: 'none',
    });
    expect(result.version).toBe('2');
    expect(result.xmlProlog).toEqual({ version: '1.0', encoding: 'UTF-8', standalone: 'no' });
    expect(result.warnings).toEqual([]);
    expect(result.endOffset).toBe(OFX2_HEADER.length);
    expect(text[result.endOffset]).toBe('<');
  });

  it('parses single-quoted attributes', () => {
    const text = `<?OFX OFXHEADER='201' VERSION='203'?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('201');
    expect(result.header.VERSION).toBe('203');
    expect(result.version).toBe('2');
  });

  it('parses unquoted attributes', () => {
    const text = `<?OFX OFXHEADER=200 VERSION=200?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.version).toBe('2');
  });

  it('handles the XML prolog before the OFX PI', () => {
    const text =
      `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="201"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.xmlProlog?.encoding).toBe('UTF-8');
    expect(result.version).toBe('2');
  });

  it('handles a lowercase <?ofx and case-insensitive attribute names', () => {
    const text = `<?ofx ofxheader="200" version="203"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.version).toBe('2');
  });

  it('warns on an unterminated processing instruction at EOF', () => {
    const text = `<?OFX OFXHEADER="200" VERSION="203"`;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('header-unterminated');
    expect(result.warnings[0]?.line).toBe(1);
    expect(result.warnings[0]?.column).toBe(1);
  });

  it('warns when a PI ends with > instead of ?>', () => {
    const text = `<?OFX OFXHEADER="200">` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.warnings[0]?.code).toBe('header-unterminated');
  });

  it('skips non-OFX processing instructions (e.g. xml-stylesheet)', () => {
    const text =
      `<?xml-stylesheet href="ofx.xsl"?><?OFX OFXHEADER="200" VERSION="200"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({ OFXHEADER: '200', VERSION: '200' });
    expect(result.warnings).toEqual([]);
  });

  it('tolerates newlines inside processing instructions', () => {
    const text = `<?OFX\n  OFXHEADER="200"\n  VERSION="203"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.version).toBe('2');
  });

  it('tolerates attributes without values', () => {
    const text = `<?OFX OFXHEADER="200" LOCKED?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.LOCKED).toBe('');
    expect(result.header.OFXHEADER).toBe('200');
  });

  it('tolerates stray ? characters inside the instruction', () => {
    const text = `<?OFX ?? OFXHEADER="200"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.warnings).toEqual([]);
  });

  it('tolerates garbage characters between attributes', () => {
    const text = `<?OFX ! OFXHEADER="200"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.warnings).toEqual([]);
  });

  it('treats a PI ending in trailing whitespace at EOF as unterminated', () => {
    const text = `<?OFX OFXHEADER="200" `;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.warnings[0]?.code).toBe('header-unterminated');
  });

  it('parses an unterminated quoted value at EOF', () => {
    const text = `<?OFX OFXHEADER="200`;
    const result = parseOfxHeader(text);
    expect(result.header.OFXHEADER).toBe('200');
    expect(result.warnings[0]?.code).toBe('header-unterminated');
  });

  it('reports missing header when only the XML prolog is present', () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>` + OFX_BODY;
    const result = parseOfxHeader(text);
    expect(result.header).toEqual({});
    expect(result.xmlProlog?.encoding).toBe('UTF-8');
    expect(result.warnings[0]?.code).toBe('missing-header');
    expect(result.version).toBe('unknown');
  });
});

describe('parseOfxHeader — missing or garbage headers', () => {
  it('warns when the file starts directly with the body', () => {
    const result = parseOfxHeader(OFX_BODY);
    expect(result.header).toEqual({});
    expect(result.version).toBe('unknown');
    expect(result.warnings).toEqual([
      { code: 'missing-header', message: 'Missing or unrecognized OFX header', line: 1, column: 1 },
    ]);
    expect(result.endOffset).toBe(0);
  });

  it('warns at the right position after leading whitespace', () => {
    const result = parseOfxHeader('\r\n\r\n' + OFX_BODY);
    expect(result.warnings[0]?.line).toBe(3);
    expect(result.warnings[0]?.column).toBe(1);
  });

  it('warns on a garbage first line', () => {
    const result = parseOfxHeader('THIS IS NOT OFX\r\n' + OFX_BODY);
    expect(result.header).toEqual({});
    expect(result.warnings[0]?.code).toBe('missing-header');
  });

  it('warns on empty input', () => {
    const result = parseOfxHeader('');
    expect(result.header).toEqual({});
    expect(result.version).toBe('unknown');
    expect(result.endOffset).toBe(0);
    expect(result.warnings[0]?.code).toBe('missing-header');
  });

  it('warns on whitespace-only input', () => {
    const result = parseOfxHeader('  \r\n\t\n');
    expect(result.warnings[0]?.code).toBe('missing-header');
  });

  it('strict mode throws OfxParseError with location and code', () => {
    expect(() => parseOfxHeader(OFX_BODY, { strict: true })).toThrow(OfxParseError);
    try {
      parseOfxHeader(OFX_BODY, { strict: true });
      expect.unreachable('parseOfxHeader should have thrown');
    } catch (error) {
      const parseError = error as OfxParseError;
      expect(parseError.name).toBe('OfxParseError');
      expect(parseError.code).toBe('missing-header');
      expect(parseError.line).toBe(1);
      expect(parseError.column).toBe(1);
      expect(parseError.message).toBe('Missing or unrecognized OFX header');
    }
  });

  it('strict mode is happy with a well-formed header', () => {
    const result = parseOfxHeader(OFX1_HEADER_1252 + OFX_BODY, { strict: true });
    expect(result.warnings).toEqual([]);
    expect(result.version).toBe('1');
  });
});
