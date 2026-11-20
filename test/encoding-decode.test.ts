import { describe, expect, it } from 'vitest';
import { decodeOfx } from '../src/encoding/decode.js';
import {
  concatBytes,
  cp1252Bytes,
  latin1Bytes,
  OFX1_HEADER_1252,
  OFX1_HEADER_ASCII,
  OFX2_HEADER,
  OFX_BODY,
  utf16Bytes,
  utf32Bytes,
  utf8Bytes,
} from './helpers.js';

/** File text encoded as windows-1252, with the Itaú-style header. */
function ofx1252(body: string): Uint8Array {
  return cp1252Bytes(OFX1_HEADER_1252 + body);
}

describe('decodeOfx — empty and BOM inputs', () => {
  it('decodes an empty buffer to empty text without warnings', () => {
    const result = decodeOfx(new Uint8Array(0));
    expect(result.text).toBe('');
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings).toEqual([]);
    expect(result.detection.source).toBe('empty');
  });

  it('strips a UTF-8 BOM and decodes the content', () => {
    const bytes = concatBytes(Uint8Array.from([0xef, 0xbb, 0xbf]), utf8Bytes('Café ação'));
    const result = decodeOfx(bytes);
    expect(result.text).toBe('Café ação');
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings).toEqual([]);
  });

  it('decodes a UTF-16LE BOM file end-to-end', () => {
    const text = OFX1_HEADER_1252 + OFX_BODY;
    const bytes = concatBytes(Uint8Array.from([0xff, 0xfe]), utf16Bytes(text, true));
    const result = decodeOfx(bytes);
    expect(result.text).toBe(text);
    expect(result.encoding).toBe('utf-16le');
    expect(result.warnings).toEqual([]);
  });

  it('decodes a UTF-16BE BOM file end-to-end', () => {
    const text = OFX1_HEADER_1252 + OFX_BODY;
    const bytes = concatBytes(Uint8Array.from([0xfe, 0xff]), utf16Bytes(text, false));
    const result = decodeOfx(bytes);
    expect(result.text).toBe(text);
    expect(result.encoding).toBe('utf-16be');
  });

  it('decodes a BOM-less NUL-interleaved UTF-16 file', () => {
    const text = 'OFXHEADER:100\r\nDATA:OFXSGML\r\n';
    const result = decodeOfx(utf16Bytes(text, true));
    expect(result.text).toBe(text);
    expect(result.encoding).toBe('utf-16le');
    expect(result.detection.source).toBe('utf16-pattern');
  });

  it('warns and drops the odd trailing byte of a truncated UTF-16 file', () => {
    const bytes = concatBytes(
      Uint8Array.from([0xff, 0xfe]),
      utf16Bytes('OFX', true),
      Uint8Array.from([0x41]),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe('OFX');
    expect(result.warnings).toEqual([
      { code: 'truncated-utf16', message: 'Dropped 1 trailing byte(s) while decoding UTF-16.' },
    ]);
  });

  it('decodes a UTF-32 BOM file and warns about trailing bytes', () => {
    const bytes = concatBytes(
      Uint8Array.from([0xff, 0xfe, 0x00, 0x00]),
      utf32Bytes('OFX', true),
      Uint8Array.from([0x41, 0x42]),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe('OFX');
    expect(result.warnings.map((w) => w.code)).toEqual(['truncated-utf32']);
  });

  it('decodes a UTF-32 BOM file and warns about invalid code units', () => {
    const bytes = concatBytes(
      Uint8Array.from([0x00, 0x00, 0xfe, 0xff]),
      Uint8Array.from([0x00, 0x11, 0x00, 0x00]), // BE 0x00110000 > U+10FFFF
      utf32Bytes('A', false),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe('\ufffdA');
    expect(result.warnings.map((w) => w.code)).toEqual(['invalid-utf32']);
  });
});

describe('decodeOfx — honest files', () => {
  it('decodes a genuine windows-1252 file (Itaú-style) without warnings', () => {
    const body = '<OFX><MEMO>Café ção — R$ 12,50</MEMO></OFX>';
    const result = decodeOfx(ofx1252(body));
    expect(result.text).toBe(OFX1_HEADER_1252 + body);
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings).toEqual([]);
  });

  it('decodes a genuine UTF-8 file declared as UTF-8 without warnings', () => {
    const header = ['OFXHEADER:100', 'ENCODING:UTF-8', 'CHARSET:NONE', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + '<OFX><MEMO>Café ção</MEMO></OFX>');
    const result = decodeOfx(bytes);
    expect(result.text).toBe(header + '<OFX><MEMO>Café ção</MEMO></OFX>');
    expect(result.warnings).toEqual([]);
    expect(result.encoding).toBe('utf-8');
  });

  it('decodes a pure-ASCII US-ASCII file without warnings', () => {
    const bytes = utf8Bytes(OFX1_HEADER_ASCII + OFX_BODY);
    const result = decodeOfx(bytes);
    expect(result.encoding).toBe('us-ascii');
    expect(result.warnings).toEqual([]);
    expect(result.text).toBe(OFX1_HEADER_ASCII + OFX_BODY);
  });

  it('decodes a genuine ISO-8859-1 file without repairs', () => {
    const header = ['OFXHEADER:100', 'ENCODING:ISO-8859-1', '', ''].join('\r\n');
    const bytes = concatBytes(latin1Bytes(header), latin1Bytes('<OFX><MEMO>Café ção</MEMO></OFX>'));
    const result = decodeOfx(bytes);
    expect(result.text).toBe(header + '<OFX><MEMO>Café ção</MEMO></OFX>');
    expect(result.encoding).toBe('iso-8859-1');
    expect(result.warnings).toEqual([]);
  });

  it('decodes a BOM-less valid-UTF-8 file with no header via the heuristic', () => {
    const bytes = utf8Bytes('São Paulo —ação');
    const result = decodeOfx(bytes);
    expect(result.text).toBe('São Paulo —ação');
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings).toEqual([]);
    expect(result.detection.source).toBe('utf8-heuristic');
  });

  it('decodes a BOM-less windows-1252 file with no header via the fallback, without warnings', () => {
    const bytes = cp1252Bytes('São Paulo — ção');
    const result = decodeOfx(bytes);
    expect(result.text).toBe('São Paulo — ção');
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings).toEqual([]);
    expect(result.detection.source).toBe('fallback');
  });
});

describe('decodeOfx — the header lies (mojibake repair)', () => {
  it('repairs whole-file mojibake: header says 1252, content is UTF-8', () => {
    const bytes = utf8Bytes(OFX1_HEADER_1252 + '<OFX><MEMO>Café ção</MEMO></OFX>');
    const result = decodeOfx(bytes);
    expect(result.text).toBe(OFX1_HEADER_1252 + '<OFX><MEMO>Café ção</MEMO></OFX>');
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings).toEqual([
      {
        code: 'mojibake-repaired',
        message: "Header declared '1252' but the content is valid UTF-8; decoded as UTF-8.",
      },
    ]);
  });

  it('repairs the classic Ã§ mojibake bytes', () => {
    // Header declares 1252; the body is UTF-8 for "Pix enviado ç".
    const body = concatBytes(
      utf8Bytes('<OFX><MEMO>Pix enviado '),
      Uint8Array.from([0xc3, 0xa7]), // UTF-8 ç
      utf8Bytes('</MEMO></OFX>'),
    );
    const result = decodeOfx(concatBytes(latin1Bytes(OFX1_HEADER_1252), body));
    expect(result.text).toBe(OFX1_HEADER_1252 + '<OFX><MEMO>Pix enviado ç</MEMO></OFX>');
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings[0]?.code).toBe('mojibake-repaired');
  });

  it('repairs a US-ASCII declaration whose content is UTF-8', () => {
    const bytes = utf8Bytes(OFX1_HEADER_ASCII + '<OFX><MEMO>Ação é fácil</MEMO></OFX>');
    const result = decodeOfx(bytes);
    expect(result.text).toBe(OFX1_HEADER_ASCII + '<OFX><MEMO>Ação é fácil</MEMO></OFX>');
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings[0]?.code).toBe('mojibake-repaired');
    expect(result.warnings[0]?.message).toContain('USASCII');
  });

  it('does not repair when the declaration is honest (genuine 1252 é)', () => {
    // A real windows-1252 é (0xE9) is not valid UTF-8: no repair, no warning.
    const result = decodeOfx(ofx1252('<OFX><MEMO>Café</MEMO></OFX>'));
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings).toEqual([]);
    expect(result.text).toContain('Café');
  });
});

describe('decodeOfx — reverse lies and mixed content', () => {
  it('repairs a UTF-8 declaration whose content is windows-1252', () => {
    const header = ['OFXHEADER:100', 'ENCODING:UTF-8', 'CHARSET:NONE', '', ''].join('\r\n');
    const bytes = concatBytes(latin1Bytes(header), latin1Bytes('<OFX><MEMO>Café ção</MEMO></OFX>'));
    const result = decodeOfx(bytes);
    expect(result.text).toBe(header + '<OFX><MEMO>Café ção</MEMO></OFX>');
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings.map((w) => w.code)).toEqual(['charset-mismatch']);
  });

  it('repairs a US-ASCII declaration whose content is windows-1252', () => {
    const bytes = concatBytes(latin1Bytes(OFX1_HEADER_ASCII), latin1Bytes('<OFX>Mémó ção</OFX>'));
    const result = decodeOfx(bytes);
    expect(result.text).toBe(OFX1_HEADER_ASCII + '<OFX>Mémó ção</OFX>');
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings.map((w) => w.code)).toEqual(['charset-mismatch']);
    expect(result.warnings[0]?.message).toContain('US-ASCII');
  });

  it('repairs a UTF-8 BOM file whose content is windows-1252', () => {
    const bytes = concatBytes(
      Uint8Array.from([0xef, 0xbb, 0xbf]),
      latin1Bytes('OFXHEADER:100\r\n\r\n<OFX>Café ção</OFX>'),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe('OFXHEADER:100\r\n\r\n<OFX>Café ção</OFX>');
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings.map((w) => w.code)).toEqual(['charset-mismatch']);
  });

  it('repairs mixed content: UTF-8 runs amid single-byte text', () => {
    // Declared 1252. Body: "abc" + é(UTF-8) + "def" + ç(0xE7) + "ghi" + 😀(UTF-8) + "jkl".
    const body = concatBytes(
      utf8Bytes('<OFX>abc'),
      Uint8Array.from([0xc3, 0xa9]), // é as UTF-8
      utf8Bytes('def'),
      Uint8Array.from([0xe7]), // ç as latin1
      utf8Bytes('ghi'),
      Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]), // 😀 as UTF-8
      utf8Bytes('jkl</OFX>'),
    );
    const result = decodeOfx(concatBytes(latin1Bytes(OFX1_HEADER_1252), body));
    expect(result.text).toBe(`${OFX1_HEADER_1252}<OFX>abcédefçghi😀jkl</OFX>`);
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings.map((w) => w.code)).toEqual(['mojibake-repaired']);
    expect(result.warnings[0]?.message).toContain('2 UTF-8 byte range(s)');
  });

  it('repairs mixed content behind a UTF-8 BOM, including trailing bytes', () => {
    // BOM says UTF-8, but the content mixes a UTF-8 run with single-byte bytes.
    const bytes = concatBytes(
      Uint8Array.from([0xef, 0xbb, 0xbf]),
      Uint8Array.from([0xc3, 0xa9]), // é as UTF-8 (valid run)
      Uint8Array.from([0xe7]), // ç as latin1 (invalid as UTF-8)
      utf8Bytes('x'),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe('éçx');
    expect(result.encoding).toBe('windows-1252');
    expect(result.warnings.map((w) => w.code)).toEqual(['mojibake-repaired']);
    expect(result.warnings[0]?.message).toContain('1 valid UTF-8 byte range(s)');
  });
});

describe('decodeOfx — ISO-8859-1 specifics', () => {
  it('maps 0x80-0x9F bytes via windows-1252 and warns', () => {
    const header = ['OFXHEADER:100', 'ENCODING:ISO-8859-1', '', ''].join('\r\n');
    const bytes = concatBytes(
      latin1Bytes(header),
      latin1Bytes('<OFX>Total '),
      Uint8Array.from([0x97]), // — in windows-1252, C1 control in strict latin1
      latin1Bytes(' 100</OFX>'),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe(`${header}<OFX>Total — 100</OFX>`);
    expect(result.warnings.map((w) => w.code)).toEqual(['latin1-c1-repaired']);
  });

  it('honours a 2.x prolog declaring ISO-8859-1 with 0x80-0x9F bytes', () => {
    const bytes = concatBytes(
      utf8Bytes(`<?xml version="1.0" encoding="ISO-8859-1"?><OFX>R$ `),
      Uint8Array.from([0x80]), // € in windows-1252
      utf8Bytes('</OFX>'),
    );
    const result = decodeOfx(bytes);
    expect(result.text).toBe('<?xml version="1.0" encoding="ISO-8859-1"?><OFX>R$ €</OFX>');
    expect(result.encoding).toBe('iso-8859-1');
    expect(result.warnings.map((w) => w.code)).toEqual(['latin1-c1-repaired']);
  });
});

describe('decodeOfx — unreliable or unsupported declarations', () => {
  it('warns about an unknown charset and decodes via heuristics', () => {
    const header = ['OFXHEADER:100', 'CHARSET:X-PT-BR-9', '', ''].join('\r\n');
    const bytes = utf8Bytes(header + '<OFX>plain ascii</OFX>');
    const result = decodeOfx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings.map((w) => w.code)).toEqual(['unsupported-charset']);
    expect(result.warnings[0]?.message).toContain('X-PT-BR-9');
  });

  it('warns about a UTF-16 prolog declaration on non-UTF-16 bytes', () => {
    const bytes = utf8Bytes(`<?xml version="1.0" encoding="UTF-16"?>` + OFX_BODY);
    const result = decodeOfx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings.map((w) => w.code)).toEqual(['unsupported-charset']);
    expect(result.warnings[0]?.message).toContain('UTF-16');
  });
});

describe('decodeOfx — end-to-end OFX 2.x', () => {
  it('decodes a canonical OFX 2.x file (prolog UTF-8, accented body)', () => {
    const bytes = utf8Bytes(OFX2_HEADER + '<OFX><MEMO>Pagamento recebido ção</MEMO></OFX>');
    const result = decodeOfx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.warnings).toEqual([]);
    expect(result.text).toBe(OFX2_HEADER + '<OFX><MEMO>Pagamento recebido ção</MEMO></OFX>');
    expect(result.detection.source).toBe('xml-prolog');
  });
});
