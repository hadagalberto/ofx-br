import { describe, expect, it } from 'vitest';
import { OfxParseError, parseSgml } from '../src/index.js';
import type { SgmlElement, SgmlParseOptions, SgmlParseResult } from '../src/index.js';

/**
 * Itaú-style body modeled after commonly observed quirks: aggregates are
 * closed, leaf elements never are, values sit on their own lines.
 */
const ITAU_BODY = [
  '<OFX>',
  '  <SIGNONMSGSRSV1>',
  '    <SONRS>',
  '      <STATUS>',
  '        <CODE>0',
  '        <SEVERITY>INFO',
  '      </STATUS>',
  '      <DTSERVER>20240115120000[-3:BRT]',
  '      <LANGUAGE>POR',
  '    </SONRS>',
  '  </SIGNONMSGSRSV1>',
  '  <BANKMSGSRSV1>',
  '    <STMTTRNRS>',
  '      <TRNUID>1',
  '      <STATUS>',
  '        <CODE>0',
  '        <SEVERITY>INFO',
  '      </STATUS>',
  '      <STMTRS>',
  '        <CURDEF>BRL',
  '        <BANKACCTFROM>',
  '          <BANKID>341',
  '          <BRANCHID>1234',
  '          <ACCTID>999999999999',
  '          <ACCTTYPE>CHECKING',
  '        </BANKACCTFROM>',
  '        <BANKTRANLIST>',
  '          <DTSTART>20240101',
  '          <DTEND>20240131',
  '          <STMTTRN>',
  '            <TRNTYPE>DEBIT',
  '            <DTPOSTED>20240105120000[-3:BRT]',
  '            <TRNAMT>-89.90',
  '            <FITID>20240105001',
  '            <MEMO>PAGAMENTO BOLETO COMPANHIA ENERGETICA',
  '          </STMTTRN>',
  '          <STMTTRN>',
  '            <TRNTYPE>CREDIT',
  '            <DTPOSTED>20240110120000[-3:BRT]',
  '            <TRNAMT>3500.00',
  '            <FITID>20240110001',
  '            <MEMO>SALARIO',
  '          </STMTTRN>',
  '        </BANKTRANLIST>',
  '        <LEDGERBAL>',
  '          <BALAMT>1234.56',
  '          <DTASOF>20240131',
  '        </LEDGERBAL>',
  '      </STMTRS>',
  '    </STMTTRNRS>',
  '  </BANKMSGSRSV1>',
  '</OFX>',
].join('\r\n');

/** Element tree without offsets, for exact-shape assertions. */
function shape(element: SgmlElement): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: element.name,
    children: element.children.map(shape),
  };
  if (element.attributes !== undefined) {
    out.attributes = element.attributes;
  }
  if (element.text !== undefined) {
    out.text = element.text;
  }
  return out;
}

function child(element: SgmlElement, name: string): SgmlElement {
  const found = element.children.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`expected a <${name}> child under <${element.name}>`);
  }
  return found;
}

function childText(element: SgmlElement, name: string): string {
  return child(element, name).text ?? '';
}

/** A warning reduced to its code and exact location, for structural asserts. */
interface WarningLocation {
  code: string;
  line: number;
  column: number;
}

/** All warnings of a parse, normalized to code + 1-based line/column. */
function warned(result: SgmlParseResult): WarningLocation[] {
  return result.warnings.map((warning) => ({
    code: warning.code,
    line: warning.line ?? 0,
    column: warning.column ?? 0,
  }));
}

/** Runs a strict parse that must throw, and returns the error. */
function strictError(text: string, options: Omit<SgmlParseOptions, 'strict'> = {}): OfxParseError {
  try {
    parseSgml(text, { ...options, strict: true });
  } catch (error) {
    if (error instanceof OfxParseError) {
      return error;
    }
    throw new Error(`expected OfxParseError, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected strict parse to throw, but it returned');
}

describe('parseSgml — well-formed input', () => {
  it('parses a fully closed document into an exact tree', () => {
    const result = parseSgml('<OFX><A>1</A><B>two</B></OFX>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [
        {
          name: 'OFX',
          children: [
            { name: 'A', children: [], text: '1' },
            { name: 'B', children: [], text: 'two' },
          ],
        },
      ],
    });
  });

  it('parses an Itaú-style body with no closing tags on leaves, with zero warnings', () => {
    const result = parseSgml(ITAU_BODY);
    expect(result.warnings).toEqual([]);
    const ofx = child(result.root, 'OFX');
    const sonrs = child(child(ofx, 'SIGNONMSGSRSV1'), 'SONRS');
    const status = child(sonrs, 'STATUS');
    expect(childText(status, 'CODE')).toBe('0');
    expect(childText(status, 'SEVERITY')).toBe('INFO');
    expect(childText(sonrs, 'DTSERVER')).toBe('20240115120000[-3:BRT]');

    const stmtTrnrs = child(child(ofx, 'BANKMSGSRSV1'), 'STMTTRNRS');
    const stmtrs = child(stmtTrnrs, 'STMTRS');
    const bankAcct = child(stmtrs, 'BANKACCTFROM');
    expect(childText(bankAcct, 'BANKID')).toBe('341');
    expect(childText(bankAcct, 'ACCTID')).toBe('999999999999');

    const transactions = child(stmtrs, 'BANKTRANLIST');
    const statementTrns = transactions.children.filter((c) => c.name === 'STMTTRN');
    expect(statementTrns.length).toBe(2);
    expect(shape(statementTrns[0] ?? transactions)).toEqual({
      name: 'STMTTRN',
      children: [
        { name: 'TRNTYPE', children: [], text: 'DEBIT' },
        { name: 'DTPOSTED', children: [], text: '20240105120000[-3:BRT]' },
        { name: 'TRNAMT', children: [], text: '-89.90' },
        { name: 'FITID', children: [], text: '20240105001' },
        { name: 'MEMO', children: [], text: 'PAGAMENTO BOLETO COMPANHIA ENERGETICA' },
      ],
    });
    expect(childText(transactions, 'DTSTART')).toBe('20240101');

    const ledger = child(stmtrs, 'LEDGERBAL');
    expect(childText(ledger, 'BALAMT')).toBe('1234.56');
    expect(childText(ledger, 'DTASOF')).toBe('20240131');
  });

  it('keeps the same tree when the whole file is on one huge line', () => {
    const oneLine = ITAU_BODY.replaceAll('\r\n', '').replaceAll('  ', '');
    const result = parseSgml(oneLine);
    expect(result.warnings).toEqual([]);
    const ofx = child(result.root, 'OFX');
    const transactions = child(
      child(child(child(ofx, 'BANKMSGSRSV1'), 'STMTTRNRS'), 'STMTRS'),
      'BANKTRANLIST',
    );
    expect(transactions.children.filter((c) => c.name === 'STMTTRN').length).toBe(2);
    const firstTrn = transactions.children.find((c) => c.name === 'STMTTRN');
    expect(firstTrn && childText(firstTrn, 'MEMO')).toBe('PAGAMENTO BOLETO COMPANHIA ENERGETICA');
  });

  it('matches closing tags case-insensitively and uppercases names', () => {
    const result = parseSgml('<ofx><StmtTrn><TrNaMt>1.5</TRNAMT></stmttrn></OFX>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [
        {
          name: 'OFX',
          children: [
            { name: 'STMTTRN', children: [{ name: 'TRNAMT', children: [], text: '1.5' }] },
          ],
        },
      ],
    });
  });

  it('parses XML-style attributes, unquoted values and bare flags', () => {
    const result = parseSgml('<OFX VERSION="200" security=\'none\' bare></OFX>');
    expect(result.warnings).toEqual([]);
    expect(child(result.root, 'OFX').attributes).toEqual({
      VERSION: '200',
      SECURITY: 'none',
      BARE: '',
    });
  });

  it('parses an unquoted attribute value', () => {
    const result = parseSgml('<A x=1/>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [{ name: 'A', children: [], attributes: { X: '1' } }],
    });
  });

  it('treats a self-closing tag as an empty element', () => {
    const result = parseSgml('<OFX><A/></OFX>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [{ name: 'OFX', children: [{ name: 'A', children: [] }] }],
    });
  });

  it('parses several top-level elements (wrapper-less body)', () => {
    const result = parseSgml(
      '<SIGNONMSGSRSV1><SONRS>ok</SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1>1</BANKMSGSRSV1>',
    );
    expect(result.warnings).toEqual([]);
    expect(result.root.children.map((c) => c.name)).toEqual(['SIGNONMSGSRSV1', 'BANKMSGSRSV1']);
  });

  it('returns an empty tree for empty and whitespace-only input', () => {
    for (const text of ['', '   \r\n\t']) {
      const result = parseSgml(text);
      expect(result.root.name).toBe('#document');
      expect(result.root.children).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  it('skips comments, processing instructions and declarations in the body', () => {
    const result = parseSgml(
      '<?xml version="1.0"?><!DOCTYPE OFX SYSTEM "ofx.dtd"><A>1<!-- note -->2</A>',
    );
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'A')).toBe('12');
  });
});

describe('parseSgml — values, whitespace and newlines', () => {
  it('trims edges but preserves interior whitespace of values', () => {
    const result = parseSgml('<MEMO>   spaced  out   </MEMO>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'MEMO')).toBe('spaced  out');
  });

  it('preserves interior mixed newlines (CRLF, LF, CR)', () => {
    const result = parseSgml('<MEMO>l1\r\nl2\nl3\rl4</MEMO>');
    expect(childText(result.root, 'MEMO')).toBe('l1\r\nl2\nl3\rl4');
  });

  it('trims CRLF/LF/CR/tab padding around values', () => {
    const result = parseSgml('<A>\r\n  x  \r\n\t</A>');
    expect(childText(result.root, 'A')).toBe('x');
  });

  it('does not trim non-breaking spaces inside values', () => {
    const result = parseSgml('<A>\u00a0x\u00a0</A>');
    expect(childText(result.root, 'A')).toBe('\u00a0x\u00a0');
  });

  it('drops whitespace-only values and keeps empty elements childless', () => {
    const result = parseSgml('<A>   </A><B></B>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [
        { name: 'A', children: [] },
        { name: 'B', children: [] },
      ],
    });
  });

  it('keeps indentation between elements from turning aggregates into leaves', () => {
    // The '\r\n    ' between <BANKTRANLIST> and <STMTTRN> must not close
    // BANKTRANLIST as a "leaf": STMTTRN must nest inside it.
    const doc =
      '<BANKTRANLIST>\r\n    <STMTTRN>\r\n        <TRNAMT>1.00\r\n    </STMTTRN>\r\n</BANKTRANLIST>';
    const result = parseSgml(doc);
    expect(result.warnings).toEqual([]);
    const list = child(result.root, 'BANKTRANLIST');
    expect(list.children.map((c) => c.name)).toEqual(['STMTTRN']);
    expect(childText(child(list, 'STMTTRN'), 'TRNAMT')).toBe('1.00');
  });

  it('parses an empty aggregate (e.g. an empty BANKTRANLIST)', () => {
    const result = parseSgml('<OFX><BANKTRANLIST>\r\n</BANKTRANLIST></OFX>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [{ name: 'OFX', children: [{ name: 'BANKTRANLIST', children: [] }] }],
    });
  });

  it('closes a leaf implicitly when the next tag opens (legal SGML)', () => {
    const result = parseSgml('<STATUS><CODE>0<SEVERITY>INFO</STATUS>');
    expect(result.warnings).toEqual([]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [
        {
          name: 'STATUS',
          children: [
            { name: 'CODE', children: [], text: '0' },
            { name: 'SEVERITY', children: [], text: 'INFO' },
          ],
        },
      ],
    });
  });
});

describe('parseSgml — entities', () => {
  it('decodes the predefined entities', () => {
    const result = parseSgml('<MEMO>a&amp;b&lt;c&gt;d&quot;e&apos;f&nbsp;g</MEMO>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'MEMO')).toBe('a&b<c>d"e\'f\u00a0g');
  });

  it('decodes decimal and hex numeric references', () => {
    const result = parseSgml('<A>&#65;&#x42;&#X43;&#xAB;&#xab;&#231;</A>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'A')).toBe('ABC««ç');
  });

  it('recovers invalid numeric references as U+FFFD', () => {
    const result = parseSgml('<A>&#0;&#xD800;&#x110000;</A>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'A')).toBe('\ufffd\ufffd\ufffd');
  });

  it('keeps a raw ampersand as literal text, without warnings', () => {
    const result = parseSgml('<MEMO>AT&T & JOÃO &amp; CIA</MEMO>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'MEMO')).toBe('AT&T & JOÃO & CIA');
  });

  it('keeps an unfinished entity-looking run as literal text', () => {
    const result = parseSgml('<A>x&amp y&#65 z& w&#</A>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'A')).toBe('x&amp y&#65 z& w&#');
  });

  it('treats a whitespace-only entity value as no content', () => {
    const result = parseSgml('<A>&#32;<B>1</B></A>');
    expect(result.warnings).toEqual([]);
    // The space entity does not turn <A> into a leaf: <B> is its child.
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [{ name: 'A', children: [{ name: 'B', children: [], text: '1' }] }],
    });
  });

  it('warns on unknown-but-well-formed entities and keeps them literal', () => {
    const result = parseSgml('<A>ab&zz;cd</A>');
    expect(warned(result)).toEqual([{ code: 'unknown-entity', line: 1, column: 6 }]);
    expect(childText(result.root, 'A')).toBe('ab&zz;cd');
  });

  it('decodes entities inside attribute values', () => {
    const result = parseSgml('<A x="&amp;&foo;">1</A>');
    expect(warned(result)).toEqual([{ code: 'unknown-entity', line: 1, column: 12 }]);
    expect(child(result.root, 'A').attributes).toEqual({ X: '&&foo;' });
    expect(childText(result.root, 'A')).toBe('1');
  });

  it('keeps a literal "<" that cannot start markup inside values', () => {
    const result = parseSgml('<MEMO>a < b e 3<5 ok</MEMO>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'MEMO')).toBe('a < b e 3<5 ok');
  });
});

describe('parseSgml — lenient repairs and warnings', () => {
  it('warns once per aggregate left open at end of input', () => {
    const result = parseSgml('<OFX><BANKTRANLIST><STMTTRN><TRNAMT>1');
    expect(warned(result)).toEqual([
      { code: 'unclosed-aggregate', line: 1, column: 1 },
      { code: 'unclosed-aggregate', line: 1, column: 6 },
      { code: 'unclosed-aggregate', line: 1, column: 20 },
    ]);
    // <TRNAMT> is a legal unclosed leaf in SGML — no fourth warning.
    const ofx = child(result.root, 'OFX');
    expect(childText(child(child(ofx, 'BANKTRANLIST'), 'STMTTRN'), 'TRNAMT')).toBe('1');
  });

  it('warns when an ancestor close implicitly closes an open aggregate', () => {
    const result = parseSgml('<A><B><C>x</A>');
    expect(warned(result)).toEqual([{ code: 'unclosed-aggregate', line: 1, column: 4 }]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [
        {
          name: 'A',
          children: [{ name: 'B', children: [{ name: 'C', children: [], text: 'x' }] }],
        },
      ],
    });
  });

  it('warns on a duplicated closing tag and keeps the tree intact', () => {
    const result = parseSgml('<OFX></OFX></OFX>');
    expect(warned(result)).toEqual([{ code: 'duplicate-close-tag', line: 1, column: 12 }]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [{ name: 'OFX', children: [] }],
    });
  });

  it('warns on a closing tag that was never opened', () => {
    const result = parseSgml('<A>x</B>');
    expect(warned(result)).toEqual([{ code: 'stray-close-tag', line: 1, column: 5 }]);
    expect(childText(result.root, 'A')).toBe('x');
  });

  it('silently skips a nameless close tag like "</>"', () => {
    const result = parseSgml('<A>1</>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'A')).toBe('1');
  });

  it('warns on trailing garbage after the document body', () => {
    const result = parseSgml('<OFX></OFX>\r\ntrailing junk');
    expect(warned(result)).toEqual([{ code: 'trailing-garbage', line: 2, column: 1 }]);
  });

  it('warns on stray text before the first element', () => {
    const result = parseSgml('garbage line\r\n<OFX></OFX>');
    expect(warned(result)).toEqual([{ code: 'stray-text', line: 1, column: 1 }]);
  });

  it('warns on stray text inside an aggregate after its children', () => {
    const result = parseSgml('<A><B>1</B>oops</A>');
    expect(warned(result)).toEqual([{ code: 'stray-text', line: 1, column: 12 }]);
    expect(childText(child(result.root, 'A'), 'B')).toBe('1');
  });

  it('strips NUL bytes anywhere and reports them once with a location', () => {
    const result = parseSgml('<OFX>\0<A>1\0</A>\0</OFX>');
    expect(warned(result)).toEqual([{ code: 'nul-byte', line: 1, column: 6 }]);
    expect(result.warnings[0]?.message).toContain('3 NUL byte');
    expect(childText(child(result.root, 'OFX'), 'A')).toBe('1');
  });

  it('counts NUL bytes inside tags, comments and declarations too', () => {
    const result = parseSgml('<A\0>1<!--\0--></A>');
    expect(warned(result)).toEqual([{ code: 'nul-byte', line: 1, column: 3 }]);
    expect(childText(result.root, 'A')).toBe('1');
  });

  it('warns when the document ends inside an open tag', () => {
    const result = parseSgml('<A>1<B');
    expect(warned(result)).toEqual([{ code: 'unterminated-tag', line: 1, column: 5 }]);
    expect(childText(result.root, 'A')).toBe('1');
  });

  it('warns when the document ends inside an attribute value', () => {
    const result = parseSgml('<A x="unterminated');
    expect(warned(result)).toEqual([{ code: 'unterminated-tag', line: 1, column: 1 }]);
  });

  it('warns when the document ends inside a closing tag or declaration', () => {
    expect(warned(parseSgml('<A>1</B'))).toEqual([
      { code: 'unterminated-tag', line: 1, column: 5 },
    ]);
    expect(warned(parseSgml('<A>1<!DOCTYP'))).toEqual([
      { code: 'unterminated-tag', line: 1, column: 5 },
    ]);
  });

  it('warns when a closing tag has unterminated innards', () => {
    const result = parseSgml('<A>1</A x');
    expect(warned(result)).toEqual([{ code: 'unterminated-tag', line: 1, column: 5 }]);
    expect(childText(result.root, 'A')).toBe('1');
  });

  it('accepts a processing instruction closed by a bare ">"', () => {
    const result = parseSgml('<A>1<?pi junk>2</A>');
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'A')).toBe('12');
  });

  it('counts NUL bytes inside declarations', () => {
    const result = parseSgml('<A>1<!X\0>2</A>');
    expect(warned(result)).toEqual([{ code: 'nul-byte', line: 1, column: 8 }]);
    expect(childText(result.root, 'A')).toBe('12');
  });

  it('counts NUL bytes inside processing instructions', () => {
    const result = parseSgml('<A>1<?x\0>2</A>');
    expect(warned(result)).toEqual([{ code: 'nul-byte', line: 1, column: 8 }]);
    expect(childText(result.root, 'A')).toBe('12');
  });

  it('warns when an open tag ends at EOF after whitespace', () => {
    expect(warned(parseSgml('<A>1<B '))).toEqual([
      { code: 'unterminated-tag', line: 1, column: 5 },
    ]);
  });

  it('tolerates garbage characters inside an open tag', () => {
    const result = parseSgml('<A * x=1>2</A>');
    expect(result.warnings).toEqual([]);
    expect(child(result.root, 'A').attributes).toEqual({ X: '1' });
    expect(childText(result.root, 'A')).toBe('2');
  });

  it('warns on an unterminated comment', () => {
    const result = parseSgml('<A>1<!-- dangling');
    expect(warned(result)).toEqual([{ code: 'unterminated-comment', line: 1, column: 5 }]);
    expect(childText(result.root, 'A')).toBe('1');
  });

  it('warns on an unterminated processing instruction', () => {
    const result = parseSgml('<A>1<?pi');
    expect(warned(result)).toEqual([{ code: 'unterminated-tag', line: 1, column: 5 }]);
  });

  it('reports warnings in document order with exact lines and columns', () => {
    const text = '<OFX>\n<A>1</A>\n<B>2\n</OFX>\n</OFX>\ngarbage';
    const result = parseSgml(text);
    expect(warned(result)).toEqual([
      { code: 'duplicate-close-tag', line: 5, column: 1 },
      { code: 'trailing-garbage', line: 6, column: 1 },
    ]);
  });

  it('tolerates stray slashes inside tags', () => {
    const result = parseSgml('<A//>1</A>');
    expect(warned(result)).toEqual([
      { code: 'trailing-garbage', line: 1, column: 6 },
      { code: 'duplicate-close-tag', line: 1, column: 7 },
    ]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [{ name: 'A', children: [] }],
    });
  });

  it('never overflows the call stack on pathological nesting', () => {
    const depth = 10_000;
    const doc = Array.from({ length: depth }, (_, i) => `<N${i}>`).join('');
    const result = parseSgml(doc);
    // Every level but the innermost is an unclosed aggregate, so the warning
    // list saturates and reports the cap.
    expect(result.warnings.length).toBe(1001);
    expect(result.warnings[1000]?.code).toBe('warnings-truncated');
    let node: SgmlElement | undefined = result.root.children[0];
    let seen = 0;
    while (node !== undefined) {
      seen++;
      node = node.children[0];
    }
    expect(seen).toBe(depth);
  });

  it('treats repeated unclosed same-name aggregates as siblings, not nests', () => {
    const doc = '<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<STMTTRN><TRNTYPE>CREDIT</BANKTRANLIST>';
    const result = parseSgml(doc);
    expect(warned(result)).toEqual([
      { code: 'unclosed-aggregate', line: 1, column: 15 },
      { code: 'unclosed-aggregate', line: 1, column: 38 },
    ]);
    const list = child(result.root, 'BANKTRANLIST');
    expect(list.children.map((c) => c.name)).toEqual(['STMTTRN', 'STMTTRN']);
    expect(childText(list.children[0] ?? list, 'TRNTYPE')).toBe('DEBIT');
    expect(childText(list.children[1] ?? list, 'TRNTYPE')).toBe('CREDIT');
  });

  it('treats repeated unclosed same-name leaves as siblings', () => {
    const result = parseSgml('<STATUS><CODE>0<STATUS><CODE>1');
    expect(warned(result)).toEqual([
      { code: 'unclosed-aggregate', line: 1, column: 1 },
      { code: 'unclosed-aggregate', line: 1, column: 16 },
    ]);
    expect(shape(result.root)).toEqual({
      name: '#document',
      children: [
        { name: 'STATUS', children: [{ name: 'CODE', children: [], text: '0' }] },
        { name: 'STATUS', children: [{ name: 'CODE', children: [], text: '1' }] },
      ],
    });
  });

  it('caps warnings and reports how many were suppressed', () => {
    const result = parseSgml('x<A></A>'.repeat(1200));
    expect(result.warnings.length).toBe(1001);
    expect(result.warnings[0]?.code).toBe('stray-text');
    expect(result.warnings[999]?.code).toBe('trailing-garbage');
    expect(result.warnings[1000] && warned(result)[1000]).toEqual({
      code: 'warnings-truncated',
      line: 1,
      column: 9601,
    });
    expect(result.warnings[1000]?.message).toContain('200 further problem(s)');
    expect(result.root.children.length).toBe(1200);
  });
});

describe('parseSgml — elements carry source offsets', () => {
  it('records the offset of each opening tag and of the root', () => {
    const result = parseSgml('<A>1<B>2');
    expect(result.root.offset).toBe(0);
    const [a, b] = result.root.children;
    expect(a?.name).toBe('A');
    expect(a?.offset).toBe(0);
    expect(b?.name).toBe('B');
    expect(b?.offset).toBe(4);
  });

  it('honours startOffset so locations stay file-global', () => {
    const header = 'OFXHEADER:100\r\nVERSION:102\r\n\r\n';
    const text = `${header}<OFX>\r\n<A>1\r\n`;
    const result = parseSgml(text, { startOffset: header.length });
    expect(result.root.offset).toBe(header.length);
    expect(warned(result)).toEqual([{ code: 'unclosed-aggregate', line: 4, column: 1 }]);
    const ofx = result.root.children[0];
    expect(ofx?.offset).toBe(header.length);
    expect(ofx?.children[0]?.offset).toBe(header.length + '<OFX>\r\n'.length);
  });

  it('clamps an out-of-range startOffset', () => {
    const result = parseSgml('<OFX></OFX>', { startOffset: 999 });
    expect(result.root.children).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('parseSgml — flavor: xml (OFX 2.x)', () => {
  it('warns on every unclosed leaf that SGML would tolerate', () => {
    const result = parseSgml(ITAU_BODY, { flavor: 'xml' });
    expect(result.warnings.length).toBe(26);
    expect(result.warnings.every((w) => w.code === 'unclosed-leaf')).toBe(true);
    expect(warned(result)[0]).toEqual({ code: 'unclosed-leaf', line: 5, column: 9 });
  });

  it('does not warn on leaves that carry closing tags', () => {
    const result = parseSgml('<OFX><A>1</A></OFX>', { flavor: 'xml' });
    expect(result.warnings).toEqual([]);
  });

  it('still reports unclosed aggregates in XML flavor', () => {
    const result = parseSgml('<OFX><A><B>1</B>', { flavor: 'xml' });
    expect(warned(result)).toEqual([
      { code: 'unclosed-aggregate', line: 1, column: 1 },
      { code: 'unclosed-aggregate', line: 1, column: 6 },
    ]);
  });
});

describe('parseSgml — strict mode', () => {
  it('accepts a legal Itaú-style SGML body without throwing', () => {
    const result = parseSgml(ITAU_BODY, { strict: true });
    expect(result.warnings).toEqual([]);
    expect(childText(result.root, 'OFX')).toBe('');
  });

  it('accepts a well-formed XML body', () => {
    const result = parseSgml('<OFX><A>1</A></OFX>', { flavor: 'xml', strict: true });
    expect(result.warnings).toEqual([]);
  });

  it('throws on the first problem with code, line and column', () => {
    expect(strictError('<OFX><A><B>1</B>')).toMatchObject({
      code: 'unclosed-aggregate',
      line: 1,
      column: 1,
    });
    expect(strictError('<OFX></OFX></OFX>')).toMatchObject({
      code: 'duplicate-close-tag',
      line: 1,
      column: 12,
    });
    expect(strictError('<A>1</B>')).toMatchObject({
      code: 'stray-close-tag',
      line: 1,
      column: 5,
    });
    expect(strictError('<A>1</C>')).toMatchObject({
      code: 'stray-close-tag',
      line: 1,
      column: 5,
    });
    expect(strictError('<OFX></OFX>garbage')).toMatchObject({
      code: 'trailing-garbage',
      line: 1,
      column: 12,
    });
    expect(strictError('junk<OFX></OFX>')).toMatchObject({
      code: 'stray-text',
      line: 1,
      column: 1,
    });
    expect(strictError('<A><B>1</B>oops</A>')).toMatchObject({
      code: 'stray-text',
      line: 1,
      column: 12,
    });
    expect(strictError('<A>\0</A>')).toMatchObject({ code: 'nul-byte', line: 1, column: 4 });
    expect(strictError('<A>&foo;</A>')).toMatchObject({
      code: 'unknown-entity',
      line: 1,
      column: 4,
    });
    expect(strictError('<A>1<B')).toMatchObject({
      code: 'unterminated-tag',
      line: 1,
      column: 5,
    });
    expect(strictError('<A>1<!--')).toMatchObject({
      code: 'unterminated-comment',
      line: 1,
      column: 5,
    });
  });

  it('throws on unclosed leaves in XML flavor only', () => {
    expect(strictError('<A>1', { flavor: 'xml' })).toMatchObject({
      code: 'unclosed-leaf',
      line: 1,
      column: 1,
    });
    expect(parseSgml('<A>1', { flavor: 'sgml', strict: true }).warnings).toEqual([]);
  });

  it('reports the first problem in document order', () => {
    const text = '<A>\0junk</Z>\n&BAD;\n';
    expect(strictError(text)).toMatchObject({ code: 'nul-byte', line: 1, column: 4 });
  });
});
