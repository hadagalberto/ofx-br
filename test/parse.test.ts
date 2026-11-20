/**
 * Full-pipeline mapping (SPEC.md "Mapping" + "Normalized model"): sign-on,
 * bank and credit-card statements, multiple statements per file, balances,
 * transactions — through `parse` (text) and `parseBuffer` (bytes). Fixtures
 * are synthetic, modeled after commonly observed quirks of Brazilian
 * exports; no real personal data.
 */
import { describe, expect, it } from 'vitest';
import { OfxParseError, parse, parseBuffer } from '../src/index.js';
import type { OfxDocument, ParseOptions, Transaction } from '../src/index.js';
import { OFX1_HEADER_1252, concatBytes, cp1252Bytes, utf16Bytes, utf8Bytes } from './helpers.js';

const B = (cents: number): bigint => BigInt(cents);

/**
 * Itaú-style OFX 1.x: key:value header declaring 1252, aggregates closed,
 * leaf elements unclosed (legal per the OFX 1.x DTD), values on their own
 * lines, CRLF line endings.
 */
const ITAU_FILE = [
  OFX1_HEADER_1252,
  '<OFX>',
  '<SIGNONMSGSRSV1>',
  '<SONRS>',
  '<STATUS>',
  '<CODE>0',
  '<SEVERITY>INFO',
  '</STATUS>',
  '<DTSERVER>20240115120000[-3:BRT]',
  '<LANGUAGE>POR',
  '<FI>',
  '<ORG>ITAU UNIBANCO HOLDING',
  '<FID>0010',
  '</FI>',
  '</SONRS>',
  '</SIGNONMSGSRSV1>',
  '<BANKMSGSRSV1>',
  '<STMTTRNRS>',
  '<TRNUID>1',
  '<STATUS>',
  '<CODE>0',
  '<SEVERITY>INFO',
  '</STATUS>',
  '<STMTRS>',
  '<CURDEF>BRL',
  '<BANKACCTFROM>',
  '<BANKID>341',
  '<BRANCHID>1234',
  '<ACCTID>999999999999',
  '<ACCTTYPE>CHECKING',
  '</BANKACCTFROM>',
  '<BANKTRANLIST>',
  '<DTSTART>20240101',
  '<DTEND>20240131',
  '<STMTTRN>',
  '<TRNTYPE>DEBIT',
  '<DTPOSTED>20240105120000[-3:BRT]',
  '<TRNAMT>-89.90',
  '<FITID>20240105001',
  '<NAME>PAGAMENTO BOLETO',
  '<MEMO>COMPANHIA ENERGETICA',
  '</STMTTRN>',
  '<STMTTRN>',
  '<TRNTYPE>CREDIT',
  '<DTPOSTED>20240110120000[-3:BRT]',
  '<TRNAMT>3500.00',
  '<FITID>20240110001',
  '<MEMO>SALARIO JANEIRO 2024',
  '</STMTTRN>',
  '</BANKTRANLIST>',
  '<LEDGERBAL>',
  '<BALAMT>1234.56',
  '<DTASOF>20240131',
  '</LEDGERBAL>',
  '<AVAILBAL>',
  '<BALAMT>1200.56',
  '<DTASOF>20240131',
  '</AVAILBAL>',
  '</STMTRS>',
  '</STMTTRNRS>',
  '</BANKMSGSRSV1>',
  '</OFX>',
  '',
].join('\r\n');

/** Nubank-style credit card export: OFX 2.x XML, UTF-8, fully closed tags. */
const NUBANK_FILE = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
  '<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
  '<OFX>',
  '  <SIGNONMSGSRSV1>',
  '    <SONRS>',
  '      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
  '      <DTSERVER>20240201120000</DTSERVER>',
  '      <LANGUAGE>POR</LANGUAGE>',
  '    </SONRS>',
  '  </SIGNONMSGSRSV1>',
  '  <CREDITCARDMSGSRSV1>',
  '    <CCSTMTTRNRS>',
  '      <TRNUID>1</TRNUID>',
  '      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
  '      <CCSTMTRS>',
  '        <CURDEF>BRL</CURDEF>',
  '        <CCACCTFROM><ACCTID>1234********3456</ACCTID></CCACCTFROM>',
  '        <BANKTRANLIST>',
  '          <DTSTART>20240101</DTSTART>',
  '          <DTEND>20240131</DTEND>',
  '          <STMTTRN>',
  '            <TRNTYPE>DEBIT</TRNTYPE>',
  '            <DTPOSTED>20240110093700.000[-3:BRT]</DTPOSTED>',
  '            <TRNAMT>-137.90</TRNAMT>',
  '            <FITID>2024-01-10T09:37:00.000Z</FITID>',
  '            <NAME>PADARIA PÃO DOCE LTDA</NAME>',
  '            <MEMO>Compra cartão</MEMO>',
  '          </STMTTRN>',
  '          <STMTTRN>',
  '            <TRNTYPE>CREDIT</TRNTYPE>',
  '            <DTPOSTED>20240125201500.000[-3:BRT]</DTPOSTED>',
  '            <TRNAMT>1500.00</TRNAMT>',
  '            <FITID>2024-01-25T20:15:00.000Z</FITID>',
  '            <NAME>PAGAMENTO RECEBIDO</NAME>',
  '          </STMTTRN>',
  '        </BANKTRANLIST>',
  '        <LEDGERBAL><BALAMT>-123.45</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>',
  '      </CCSTMTRS>',
  '    </CCSTMTTRNRS>',
  '  </CREDITCARDMSGSRSV1>',
  '</OFX>',
  '',
].join('\n');

/** One STMTTRN block with the given leaves, aggregates closed. */
function stmttrn(fields: Record<string, string>): string {
  const lines = ['<STMTTRN>'];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`<${name}>${value}`);
  }
  lines.push('</STMTTRN>');
  return lines.join('\n');
}

/** A minimal bank-statement body around the given transaction blocks. */
function bankBody(
  blocks: string[],
  opts: { curdef?: string | null; acctid?: string } = {},
): string {
  const curdef = opts.curdef === null ? undefined : (opts.curdef ?? 'BRL');
  const acctid = opts.acctid ?? 'acc-1';
  return [
    '<OFX>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<STMTRS>',
    curdef === undefined ? '' : `<CURDEF>${curdef}`,
    '<BANKACCTFROM>',
    `<ACCTID>${acctid}`,
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    ...blocks,
    '</BANKTRANLIST>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Minimal 1.x header; the blank line matters (header/body separator). */
const MIN_HEADER = ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join('\n');

function warningsOf(doc: OfxDocument): { code: string; line?: number; column?: number }[] {
  return doc.warnings.map(({ code, line, column }) => ({ code, line, column }));
}

describe('parse — Itaú-style bank statement', () => {
  const doc = parse(ITAU_FILE);

  it('maps the OFX header and version', () => {
    expect(doc.version).toBe('1');
    expect(doc.encoding).toBe('unknown');
    expect(doc.header).toEqual({
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
  });

  it('maps the sign-on message', () => {
    expect(doc.signOn).toEqual({
      statusCode: 0,
      severity: 'INFO',
      serverDate: '2024-01-15T12:00:00-03:00',
      org: 'ITAU UNIBANCO HOLDING',
      fid: '0010',
    });
  });

  it('maps the statement, the account and the balances', () => {
    expect(doc.statements).toHaveLength(1);
    const [statement] = doc.statements;
    expect(statement?.kind).toBe('bank');
    expect(statement?.currency).toBe('BRL');
    expect(statement?.account).toEqual({
      bankId: '341',
      bankName: 'ITAÚ UNIBANCO S.A.',
      branchId: '1234',
      accountId: '999999999999',
      accountType: 'CHECKING',
    });
    expect(statement?.period).toEqual({ start: '2024-01-01', end: '2024-01-31' });
    expect(statement?.ledgerBalance).toEqual({
      amount: { cents: B(123456), currency: 'BRL' },
      date: '2024-01-31',
    });
    expect(statement?.availableBalance).toEqual({
      amount: { cents: B(120056), currency: 'BRL' },
      date: '2024-01-31',
    });
  });

  it('maps the transactions with merged descriptions and unique ids', () => {
    const [statement] = doc.statements;
    const [first, second] = statement?.transactions ?? [];
    expect(first).toEqual({
      id: '20240105001',
      fitid: '20240105001',
      type: 'DEBIT',
      direction: 'debit',
      amount: { cents: B(-8990), currency: 'BRL' },
      postedAt: '2024-01-05T12:00:00-03:00',
      description: 'PAGAMENTO BOLETO COMPANHIA ENERGETICA',
      name: 'PAGAMENTO BOLETO',
      memo: 'COMPANHIA ENERGETICA',
      category: 'boleto',
      counterparty: { name: 'COMPANHIA ENERGETICA' },
    } satisfies Transaction);
    expect(second).toEqual({
      id: '20240110001',
      fitid: '20240110001',
      type: 'CREDIT',
      direction: 'credit',
      amount: { cents: B(350000), currency: 'BRL' },
      postedAt: '2024-01-10T12:00:00-03:00',
      description: 'SALARIO JANEIRO 2024',
      memo: 'SALARIO JANEIRO 2024',
    } satisfies Transaction);
  });

  it('is warning-free: the Itaú quirk set is legal per the OFX 1.x DTD', () => {
    expect(doc.warnings).toEqual([]);
  });
});

describe('parse — Nubank-style credit-card statement (OFX 2.x XML)', () => {
  const doc = parse(NUBANK_FILE);

  it('detects version 2 and parses the XML body with no warnings', () => {
    expect(doc.version).toBe('2');
    expect(doc.warnings).toEqual([]);
  });

  it('maps sign-on with the BRT default for a tz-less DTSERVER', () => {
    expect(doc.signOn).toEqual({
      statusCode: 0,
      severity: 'INFO',
      serverDate: '2024-02-01T12:00:00-03:00',
    });
  });

  it('maps the credit-card statement', () => {
    expect(doc.statements).toHaveLength(1);
    const [statement] = doc.statements;
    expect(statement?.kind).toBe('creditcard');
    expect(statement?.currency).toBe('BRL');
    expect(statement?.account).toEqual({ accountId: '1234********3456' });
    expect(statement?.period).toEqual({ start: '2024-01-01', end: '2024-01-31' });
    expect(statement?.ledgerBalance).toEqual({
      amount: { cents: B(-12345), currency: 'BRL' },
      date: '2024-01-31',
    });
    expect(statement?.availableBalance).toBeUndefined();
    expect(statement?.transactions).toHaveLength(2);
    const [purchase, payment] = statement?.transactions ?? [];
    expect(purchase).toEqual({
      id: '2024-01-10T09:37:00.000Z',
      fitid: '2024-01-10T09:37:00.000Z',
      type: 'DEBIT',
      direction: 'debit',
      amount: { cents: B(-13790), currency: 'BRL' },
      postedAt: '2024-01-10T09:37:00-03:00',
      description: 'PADARIA PÃO DOCE LTDA Compra cartão',
      name: 'PADARIA PÃO DOCE LTDA',
      memo: 'Compra cartão',
      category: 'card-purchase',
      counterparty: { name: 'PADARIA PÃO DOCE LTDA' },
    } satisfies Transaction);
    expect(payment?.direction).toBe('credit');
    expect(payment?.amount.cents).toBe(B(150000));
    expect(payment?.description).toBe('PAGAMENTO RECEBIDO');
  });

  it('warns on unclosed leaves in the xml flavor (version drives the flavor)', () => {
    const sloppy = NUBANK_FILE.replace('<TRNTYPE>DEBIT</TRNTYPE>', '<TRNTYPE>DEBIT');
    const doc2 = parse(sloppy);
    expect(doc2.statements).toHaveLength(1);
    const unclosed = warningsOf(doc2).filter((w) => w.code === 'unclosed-leaf');
    expect(unclosed).toHaveLength(1);
  });
});

describe('parse — multiple statements per file', () => {
  const doc = parse(
    [
      MIN_HEADER,
      '<OFX>',
      '<SIGNONMSGSRSV1>',
      '<SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS></SONRS>',
      '</SIGNONMSGSRSV1>',
      '<BANKMSGSRSV1>',
      '<STMTTRNRS>',
      '<STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>001</BANKID><ACCTID>conta-corrente</ACCTID></BANKACCTFROM></STMTRS>',
      '</STMTTRNRS>',
      '<STMTTRNRS>',
      '<STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>001</BANKID><ACCTID>conta-poupanca</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM></STMTRS>',
      '</STMTTRNRS>',
      '</BANKMSGSRSV1>',
      '<CREDITCARDMSGSRSV1>',
      '<CCSTMTTRNRS>',
      '<CCSTMTRS><CURDEF>BRL<CCACCTFROM><ACCTID>cartao</ACCTID></CCACCTFROM></CCSTMTRS>',
      '</CCSTMTTRNRS>',
      '</CREDITCARDMSGSRSV1>',
      '</OFX>',
      '',
    ].join('\n'),
  );

  it('keeps every statement in document order with its kind', () => {
    expect(doc.warnings).toEqual([]);
    expect(doc.statements.map((s) => [s.kind, s.account.accountId, s.account.bankName])).toEqual([
      ['bank', 'conta-corrente', 'BCO DO BRASIL S.A.'],
      ['bank', 'conta-poupanca', 'BCO DO BRASIL S.A.'],
      ['creditcard', 'cartao', undefined],
    ]);
    expect(doc.statements[1]?.account.accountType).toBe('SAVINGS');
    expect(doc.statements[1]?.transactions).toEqual([]);
  });
});

describe('parse — wrapper-less body still maps', () => {
  it('finds message sets without <OFX>, tolerating an unclosed <STMTTRN>', () => {
    const doc = parse(
      [
        '<STMTTRNRS>',
        '<STMTRS><CURDEF>BRL<BANKACCTFROM><ACCTID>x</ACCTID></BANKACCTFROM>',
        '<BANKTRANLIST>',
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240101<TRNAMT>-1.00<FITID>t1',
        '</BANKTRANLIST>',
        '</STMTRS>',
        '</STMTTRNRS>',
        '',
      ].join('\n'),
    );
    expect(doc.statements).toHaveLength(1);
    expect(doc.statements[0]?.transactions[0]?.amount.cents).toBe(B(-100));
    // The unclosed <STMTTRN> aggregate is tolerated and reported.
    expect(warningsOf(doc)).toContainEqual({ code: 'unclosed-aggregate', line: 4, column: 1 });
  });
});

describe('parse — duplicate and missing FITIDs', () => {
  // Line numbers are asserted exactly below; the fixture is laid out for it.
  const body = bankBody([
    stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-10.00', FITID: 'dup' }),
    stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240102', TRNAMT: '-20.00', FITID: 'dup' }),
    stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240103', TRNAMT: '-30.00', FITID: 'dup' }),
  ]);
  const doc = parse(`${MIN_HEADER}${body}`);

  it('keeps all transactions with deterministic, unique ids and warns', () => {
    const ids = doc.statements[0]?.transactions.map((t) => t.id);
    expect(ids).toEqual(['dup', 'dup#2', 'dup#3']);
    expect(doc.statements[0]?.transactions.map((t) => t.fitid)).toEqual(['dup', 'dup', 'dup']);
  });

  it('warns at the exact line/column of the repeated transactions', () => {
    // Layout: header is 4 lines + a blank; each stmttrn() block is 6 lines.
    // Line 5 = <OFX>, 6 = <BANKMSGSRSV1>, 7 = <STMTTRNRS>, 8 = <STMTRS>,
    // 9 = <CURDEF>, 10..12 = BANKACCTFROM, 13 = <BANKTRANLIST>.
    // Block 1 starts at line 14 (6 lines), block 2 at line 20, block 3 at 26.
    const doc2 = parse(`${MIN_HEADER}${body}`);
    const duplicates = warningsOf(doc2).filter((w) => w.code === 'duplicate-fitid');
    expect(duplicates.map((w) => [w.line, w.column])).toEqual([
      [20, 1],
      [26, 1],
    ]);
  });

  it('is deterministic across parses', () => {
    const again = parse(`${MIN_HEADER}${body}`);
    expect(again.statements[0]?.transactions.map((t) => t.id)).toEqual(['dup', 'dup#2', 'dup#3']);
  });

  it('hashes missing FITIDs deterministically and silently', () => {
    const noFitid = bankBody([
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-10.00' }),
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-10.00' }), // identical row
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240102', TRNAMT: '-10.00', MEMO: 'different' }),
    ]);
    const docA = parse(`${MIN_HEADER}${noFitid}`);
    const docB = parse(`${MIN_HEADER}${noFitid}`);
    const ids = docA.statements[0]?.transactions.map((t) => t.id) ?? [];
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^hash-[0-9a-f]{16}$/);
    expect(ids[1]).toBe(`${ids[0]}#2`); // identical fitid-less rows: silent unique suffix
    expect(ids[2]).toMatch(/^hash-[0-9a-f]{16}$/);
    expect(ids[2]).not.toBe(ids[0]);
    expect(docB.statements[0]?.transactions.map((t) => t.id)).toEqual(ids); // deterministic
    expect(docA.statements[0]?.transactions.every((t) => t.fitid === undefined)).toBe(true);
    expect(warningsOf(docA)).toEqual([]); // fitid-less rows are not a warning
  });
});

describe('parse — amounts in every Brazilian convention', () => {
  it('parses pt-BR comma decimals and grouped thousands (Caixa-style)', () => {
    const doc = parse(
      `${MIN_HEADER}${bankBody([
        stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-1.234,56', FITID: 'a' }),
        stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240102', TRNAMT: '2.500,00', FITID: 'b' }),
        stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240103', TRNAMT: 'R$ 10,00', FITID: 'c' }),
        stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240104', TRNAMT: '+10', FITID: 'd' }),
        stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240105', TRNAMT: '1,234.56', FITID: 'e' }),
      ])}`,
    );
    expect(doc.warnings).toEqual([]);
    expect(doc.statements[0]?.transactions.map((t) => t.amount.cents)).toEqual([
      B(-123456),
      B(250000),
      B(1000),
      B(1000),
      B(123456),
    ]);
  });
});

describe('parse — lenient handling of broken values', () => {
  const doc = parse(
    `${MIN_HEADER}${bankBody(
      [
        stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: 'não-é-número', FITID: 'tx1' }),
        stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240102', FITID: 'tx2' }), // no TRNAMT at all
        stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240230', TRNAMT: '-10.00', FITID: 'tx3' }), // Feb 30
        stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: 'yesterday', TRNAMT: '-20.00', FITID: 'tx4' }),
        stmttrn({ TRNAMT: '-30.00', FITID: 'tx5' }), // no TRNTYPE, no DTPOSTED
        stmttrn({ TRNTYPE: 'XFER', DTPOSTED: '20240105', TRNAMT: '-40.00', FITID: 'tx6' }),
        stmttrn({ TRNTYPE: 'OTHER', DTPOSTED: '20240106', TRNAMT: '0.00', FITID: 'tx7' }),
      ],
      { curdef: null, acctid: 'acc-1' },
    )}`,
  );

  it('skips transactions without an amount and maps the rest', () => {
    expect(doc.statements).toHaveLength(1);
    const ids = doc.statements[0]?.transactions.map((t) => t.id);
    expect(ids).toEqual(['tx3', 'tx4', 'tx5', 'tx6', 'tx7']);
  });

  it('repairs the invalid date best-effort and never yields NaN', () => {
    const [tx3, tx4, tx5, tx6, tx7] = doc.statements[0]?.transactions ?? [];
    expect(tx3?.postedAt).toBe('2024-02-29'); // date-only value: clamped, ISO date
    expect(tx4?.postedAt).toBe('');
    expect(tx5?.postedAt).toBe('');
    expect(tx5?.type).toBe('');
    expect(tx5?.direction).toBe('debit'); // sign fallback
    expect(tx6?.direction).toBe('debit'); // XFER with negative amount
    expect(tx7?.direction).toBe('credit'); // OTHER with zero amount
  });

  it('reports every problem with its code', () => {
    const codes = warningsOf(doc).map((w) => w.code);
    expect(codes.filter((c) => c === 'invalid-amount')).toHaveLength(2);
    expect(codes).toContain('date-clamped');
    expect(codes).toContain('invalid-date');
    expect(codes).toContain('missing-trntype');
    expect(codes).toContain('missing-dtposted');
  });

  it('records XXX and warns when CURDEF is missing', () => {
    expect(doc.statements[0]?.currency).toBe('XXX');
    expect(warningsOf(doc)).toContainEqual({ code: 'missing-currency', line: 8, column: 1 });
    expect(doc.statements[0]?.transactions[0]?.amount.currency).toBe('XXX');
  });
});

describe('parse — missing account identifiers', () => {
  it('warns when ACCTID is missing', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
        '<BANKACCTFROM><BANKID>341</BANKID><BRANCHID>0001</BRANCHID></BANKACCTFROM>',
        '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements[0]?.account).toEqual({
      bankId: '341',
      bankName: 'ITAÚ UNIBANCO S.A.',
      branchId: '0001',
      accountId: '',
    });
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['missing-account-id']);
  });

  it('warns when the whole account aggregate is missing', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements[0]?.account).toEqual({ accountId: '' });
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['missing-account-id']);
  });

  it('resolves zero-padded and unpadded BANKID codes (bankId normalized, name from the table)', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
        '<BANKACCTFROM><BANKID>41</BANKID><ACCTID>a</ACCTID></BANKACCTFROM>',
        '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements[0]?.account.bankId).toBe('041');
    expect(doc.statements[0]?.account.bankName).toBe('BCO DO ESTADO DO RS S.A.');
    expect(doc.warnings).toEqual([]);
  });

  it('resolves an 8-digit ISPB in BANKID but keeps bankId verbatim', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
        '<BANKACCTFROM><BANKID>18236120</BANKID><ACCTID>a</ACCTID></BANKACCTFROM>',
        '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements[0]?.account.bankId).toBe('18236120');
    expect(doc.statements[0]?.account.bankName).toBe('NU PAGAMENTOS - IP');
    expect(doc.warnings).toEqual([]);
  });

  it('leaves foreign/unknown BANKIDs unnamed, without warnings', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD',
        '<BANKACCTFROM><BANKID>999</BANKID><ACCTID>a</ACCTID></BANKACCTFROM>',
        '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements[0]?.account.bankId).toBe('999');
    expect(doc.statements[0]?.account.bankName).toBeUndefined();
    expect(doc.warnings).toEqual([]);
  });
});

describe('parse — statement-level status problems', () => {
  it('skips a statement response with no STMTRS and reports the transaction status', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS>',
        '<STATUS><CODE>2000</CODE><SEVERITY>ERROR</SEVERITY></STATUS>',
        '</STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements).toEqual([]);
    // The array-join puts an extra blank line after the header: <OFX> is line 6.
    expect(warningsOf(doc)).toEqual([{ code: 'statement-error', line: 6, column: 20 }]);
    expect(doc.warnings[0]?.message).toContain('2000');
  });

  it('maps the statement but warns when the transaction status is nonzero', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS>',
        '<STATUS><CODE>1</CODE><SEVERITY>WARN</SEVERITY></STATUS>',
        '<STMTRS><CURDEF>BRL<BANKACCTFROM><ACCTID>a</ACCTID></BANKACCTFROM></STMTRS>',
        '</STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements).toHaveLength(1);
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['statement-status-error']);
  });

  it('falls back to statusCode 0 when SONRS CODE is garbage', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><SIGNONMSGSRSV1><SONRS>',
        '<STATUS><CODE>0x1</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
        '</SONRS></SIGNONMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.signOn).toEqual({ statusCode: 0, severity: 'INFO' });
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['invalid-status-code']);
  });

  it('maps a broken balance amount as a skipped balance with a warning', () => {
    const doc = parse(
      [
        MIN_HEADER,
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
        '<BANKACCTFROM><ACCTID>a</ACCTID></BANKACCTFROM>',
        '<LEDGERBAL><BALAMT>lots of money</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>',
        '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
        '',
      ].join('\n'),
    );
    expect(doc.statements[0]?.ledgerBalance).toBeUndefined();
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['invalid-amount']);
  });
});

describe('parse — descriptions are merged and cleaned', () => {
  it('merges NAME and MEMO, collapses whitespace runs and NBSP', () => {
    const doc = parse(
      `${MIN_HEADER}${bankBody([
        [
          '<STMTTRN>',
          '<TRNTYPE>DEBIT',
          '<DTPOSTED>20240101',
          '<TRNAMT>-1.00',
          '<FITID>x1',
          '<NAME>PAGAMENTO',
          ' ',
          'BOLETO  DO  CARRO',
          '</STMTTRN>',
        ].join('\n'),
        stmttrn({
          TRNTYPE: 'CREDIT',
          DTPOSTED: '20240102',
          TRNAMT: '2.00',
          FITID: 'x2',
          MEMO: 'ESTORNO\u00a0 \u00a0TARIFA',
        }),
        stmttrn({
          TRNTYPE: 'CREDIT',
          DTPOSTED: '20240103',
          TRNAMT: '3.00',
          FITID: 'x3',
          NAME: 'IGUAL',
          MEMO: 'IGUAL',
        }),
        stmttrn({
          TRNTYPE: 'CREDIT',
          DTPOSTED: '20240104',
          TRNAMT: '4.00',
          FITID: 'x4',
          NAME: 'SÓ NOME',
        }),
      ])}`,
    );
    const [a, b, c, d] = doc.statements[0]?.transactions ?? [];
    expect(a?.description).toBe('PAGAMENTO BOLETO DO CARRO');
    expect(a?.name).toBe('PAGAMENTO BOLETO DO CARRO');
    expect(a?.memo).toBeUndefined();
    expect(b?.description).toBe('ESTORNO TARIFA');
    expect(c?.description).toBe('IGUAL'); // NAME === MEMO → not duplicated
    expect(d?.description).toBe('SÓ NOME');
  });

  it('maps CHECKNUM, REFNUM and DTUSER', () => {
    const doc = parse(
      `${MIN_HEADER}${bankBody([
        stmttrn({
          TRNTYPE: 'CHECK',
          DTPOSTED: '20240101',
          TRNAMT: '-100.00',
          FITID: 'chq-77',
          CHECKNUM: '77',
          REFNUM: 'REF-9',
          DTUSER: '20240102',
        }),
      ])}`,
    );
    expect(doc.statements[0]?.transactions[0]).toMatchObject({
      checkNumber: '77',
      refNumber: 'REF-9',
      userDate: '2024-01-02',
      type: 'CHECK',
      direction: 'debit',
    });
    expect(doc.warnings).toEqual([]);
  });
});

describe('parse — timezone option', () => {
  const body = `${MIN_HEADER}${bankBody([
    stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240115120000', TRNAMT: '-1.00', FITID: 'tz' }),
  ])}`;

  it('defaults a missing timezone to -03:00 (BRT)', () => {
    const doc = parse(body);
    expect(doc.statements[0]?.transactions[0]?.postedAt).toBe('2024-01-15T12:00:00-03:00');
    expect(doc.warnings).toEqual([]);
  });

  it.each([
    ['0', '2024-01-15T12:00:00+00:00'],
    ['+05:30', '2024-01-15T12:00:00+05:30'],
    ['-03:00', '2024-01-15T12:00:00-03:00'],
  ])('honours tz %s', (tz, expected) => {
    const doc = parse(body, { tz });
    expect(doc.statements[0]?.transactions[0]?.postedAt).toBe(expected);
    expect(doc.warnings).toEqual([]);
  });

  it('warns and falls back on an invalid tz option', () => {
    const doc = parse(body, { tz: 'America/Sao_Paulo' });
    expect(doc.statements[0]?.transactions[0]?.postedAt).toBe('2024-01-15T12:00:00-03:00');
    expect(warningsOf(doc)).toEqual([{ code: 'invalid-tz-option' }]);
  });
});

describe('parse — strict mode', () => {
  const options: ParseOptions = { strict: true };

  function strictError(text: string, optionsOverride: ParseOptions = options): OfxParseError {
    try {
      parse(text, optionsOverride);
    } catch (error) {
      if (error instanceof OfxParseError) {
        return error;
      }
      throw new Error(`expected OfxParseError, got ${String(error)}`, { cause: error });
    }
    throw new Error('expected strict parse to throw, but it returned');
  }

  it('passes clean files through untouched', () => {
    expect(() => parse(ITAU_FILE, options)).not.toThrow();
    expect(() => parse(NUBANK_FILE, options)).not.toThrow();
  });

  it('throws on a missing header with its location', () => {
    const error = strictError('');
    expect(error.code).toBe('missing-header');
    expect(error.line).toBe(1);
    expect(error.column).toBe(1);
  });

  it('throws on an unclosed aggregate', () => {
    const error = strictError(`${MIN_HEADER}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL`);
    expect(error.code).toBe('unclosed-aggregate');
    expect(error.line).toBe(5); // <OFX> is the outermost unclosed element
    expect(error.column).toBe(1);
  });

  it('throws on an invalid amount at the offending element', () => {
    const doc = `${MIN_HEADER}${bankBody([
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: 'not-a-number', FITID: 'x' }),
    ])}`;
    const error = strictError(doc);
    expect(error.code).toBe('invalid-amount');
    expect(error.line).toBe(17); // <TRNAMT> line inside the block (14 + 3)
    expect(error.column).toBe(1);
  });

  it('throws on a duplicate FITID', () => {
    const docText = `${MIN_HEADER}${bankBody([
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-1.00', FITID: 'same' }),
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240102', TRNAMT: '-2.00', FITID: 'same' }),
    ])}`;
    const error = strictError(docText);
    expect(error.code).toBe('duplicate-fitid');
    expect(error.line).toBe(20); // second block starts 6 lines after the first
    expect(error.column).toBe(1);
  });

  it('throws on a clamped date', () => {
    const docText = `${MIN_HEADER}${bankBody([
      stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240230', TRNAMT: '-1.00', FITID: 'x' }),
    ])}`;
    const error = strictError(docText);
    expect(error.code).toBe('date-clamped');
  });
});

describe('parseBuffer — bytes → model, with decode warnings', () => {
  it('decodes a windows-1252 file and reports the used encoding', () => {
    const bytes = cp1252Bytes(
      `${OFX1_HEADER_1252}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL` +
        `<BANKACCTFROM><BANKID>237</BANKID><ACCTID>abc</ACCTID></BANKACCTFROM>` +
        `<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240101<TRNAMT>-10,00<FITID>1` +
        `<MEMO>TARIFAçãO &lt;MANUTENçãO&gt;</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
    );
    const doc = parseBuffer(bytes);
    expect(doc.encoding).toBe('windows-1252');
    expect(doc.warnings).toEqual([]);
    expect(doc.statements[0]?.account.bankName).toBe('BCO BRADESCO S.A.');
    expect(doc.statements[0]?.transactions[0]).toMatchObject({
      amount: { cents: B(-1000), currency: 'BRL' },
      description: 'TARIFAçãO <MANUTENçãO>',
    });
  });

  it('repairs a lying 1252 header over UTF-8 content (mojibake warning flows through)', () => {
    const bytes = utf8Bytes(
      `${OFX1_HEADER_1252}<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL` +
        `<BANKACCTFROM><BANKID>001</BANKID><ACCTID>x</ACCTID></BANKACCTFROM>` +
        `<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240101<TRNAMT>-5,00<FITID>9` +
        `<MEMO>COMPRA NA PADARIA CONFEITARIA DOÇURA</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
    );
    const doc = parseBuffer(bytes);
    expect(doc.encoding).toBe('utf-8');
    expect(warningsOf(doc).map((w) => w.code)).toContain('mojibake-repaired');
    expect(doc.statements[0]?.transactions[0]?.description).toBe(
      'COMPRA NA PADARIA CONFEITARIA DOÇURA',
    );
  });

  it('decodes UTF-16 files (BOM) into the model', () => {
    const bom = Uint8Array.from([0xff, 0xfe]);
    const bytes = concatBytes(
      bom,
      utf16Bytes(
        `${MIN_HEADER}<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>` +
          `<CURDEF>BRL<CCACCTFROM><ACCTID>card</ACCTID></CCACCTFROM>` +
          `<LEDGERBAL><BALAMT>10.00<DTASOF>20240131</LEDGERBAL>` +
          `</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`,
        true,
      ),
    );
    const doc = parseBuffer(bytes);
    expect(doc.encoding).toBe('utf-16le');
    expect(doc.version).toBe('1');
    expect(doc.statements[0]).toMatchObject({
      kind: 'creditcard',
      ledgerBalance: { amount: { cents: B(1000), currency: 'BRL' }, date: '2024-01-31' },
    });
  });

  it('never throws on empty or garbage bytes', () => {
    expect(() => parseBuffer(new Uint8Array(0))).not.toThrow();
    const doc = parseBuffer(Uint8Array.from([0x3c, 0x4f, 0x46, 0x58, 0x3e, 0x00, 0xff]));
    expect(doc.statements).toEqual([]);
    expect(warningsOf(doc).map((w) => w.code)).toContain('missing-header');
  });
});

describe('parse — empty and hostile input never throws (lenient)', () => {
  it('returns an empty document for the empty string with a missing-header warning', () => {
    const doc = parse('');
    expect(doc.header).toEqual({});
    expect(doc.version).toBe('unknown');
    expect(doc.signOn).toBeUndefined();
    expect(doc.statements).toEqual([]);
    expect(doc.encoding).toBe('unknown');
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]?.code).toBe('missing-header');
    expect(doc.warnings[0]?.line).toBe(1);
    expect(doc.warnings[0]?.column).toBe(1);
    expect(typeof doc.warnings[0]?.message).toBe('string');
  });

  it('tolerates a header-only file', () => {
    const doc = parse(MIN_HEADER);
    expect(doc.version).toBe('1');
    expect(doc.statements).toEqual([]);
    expect(doc.signOn).toBeUndefined();
  });

  it('tolerates pure garbage', () => {
    const doc = parse('just some text, no OFX at all');
    expect(doc.version).toBe('unknown');
    expect(doc.statements).toEqual([]);
    expect(warningsOf(doc).map((w) => w.code)).toContain('missing-header');
  });
});

describe('parse — warning cap', () => {
  it('records at most 1000 mapping warnings plus a truncation notice', () => {
    const blocks: string[] = [];
    for (let i = 0; i < 1100; i++) {
      blocks.push(
        stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: `bad-${i}`, FITID: `f${i}` }),
      );
    }
    const doc = parse(`${MIN_HEADER}${bankBody(blocks)}`);
    expect(doc.statements[0]?.transactions).toHaveLength(0);
    expect(doc.warnings).toHaveLength(1001);
    expect(doc.warnings[999]?.code).toBe('invalid-amount');
    expect(doc.warnings[1000]?.code).toBe('warnings-truncated');
    expect(doc.warnings[1000]?.message).toContain('100');
  });
});
