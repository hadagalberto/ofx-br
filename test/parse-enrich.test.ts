/**
 * Enrichment through the full `parse` pipeline (SPEC.md "Transaction
 * enrichment" + "Credit card" + "Balance check"): categories, counterparties
 * and installments on bank and credit-card statements, card sign
 * normalization, and the optional `verifyBalance` check. Fixtures are
 * synthetic, modeled after commonly observed quirks of Brazilian exports;
 * names/CPFs/CNPJs are fictional and valid-but-fake (123.456.789-09,
 ***.123.456-** masks, 00.000.000/0001-91).
 */
import { describe, expect, it } from 'vitest';
import { OfxParseError, parse } from '../src/index.js';
import type { OfxDocument, ParseOptions, Transaction } from '../src/index.js';

const B = (cents: number): bigint => BigInt(cents);

/** Minimal 1.x header; the blank line matters (header/body separator). */
const MIN_HEADER = ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join('\n');

/** One STMTTRN block with the given leaves, aggregates closed. */
function stmttrn(fields: Record<string, string>): string {
  const lines = ['<STMTTRN>'];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`<${name}>${value}`);
  }
  lines.push('</STMTTRN>');
  return lines.join('\n');
}

/**
 * A bank statement body around the given transaction blocks, optionally
 * with a LEDGERBAL (cents as a canonical OFX amount string).
 */
function bankBody(blocks: readonly string[], ledgerAmount?: string): string {
  return [
    '<OFX>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<STMTRS>',
    '<CURDEF>BRL',
    '<BANKACCTFROM>',
    '<ACCTID>acc-1',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    ...blocks,
    '</BANKTRANLIST>',
    ...(ledgerAmount === undefined
      ? []
      : ['<LEDGERBAL>', `<BALAMT>${ledgerAmount}`, '<DTASOF>20240131', '</LEDGERBAL>']),
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
    '',
  ].join('\n');
}

/** A credit-card statement body around the given transaction blocks. */
function cardBody(blocks: readonly string[], ledgerAmount?: string): string {
  return [
    '<OFX>',
    '<CREDITCARDMSGSRSV1>',
    '<CCSTMTTRNRS>',
    '<CCSTMTRS>',
    '<CURDEF>BRL',
    '<CCACCTFROM>',
    '<ACCTID>card-1',
    '</CCACCTFROM>',
    '<BANKTRANLIST>',
    ...blocks,
    '</BANKTRANLIST>',
    ...(ledgerAmount === undefined
      ? []
      : ['<LEDGERBAL>', `<BALAMT>${ledgerAmount}`, '<DTASOF>20240131', '</LEDGERBAL>']),
    '</CCSTMTRS>',
    '</CCSTMTTRNRS>',
    '</CREDITCARDMSGSRSV1>',
    '</OFX>',
    '',
  ].join('\n');
}

function transactionsOf(doc: OfxDocument, index = 0): Transaction[] {
  return doc.statements[index]?.transactions ?? [];
}

function warningsOf(doc: OfxDocument): { code: string; line?: number; column?: number }[] {
  return doc.warnings.map(({ code, line, column }) => ({ code, line, column }));
}

describe('parse — enrichment on a bank statement', () => {
  const doc = parse(
    `${MIN_HEADER}${bankBody([
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240102',
        TRNAMT: '-50.00',
        FITID: '1',
        MEMO: 'Pix enviado - MARIA DA SILVA - CPF ***.123.456-**',
      }),
      stmttrn({
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240103',
        TRNAMT: '120.00',
        FITID: '2',
        MEMO: 'Pix recebido de José Mário',
      }),
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240104',
        TRNAMT: '-300.00',
        FITID: '3',
        MEMO: 'TED BANCO DO BRASIL CNPJ 00.000.000/0001-91',
      }),
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240105',
        TRNAMT: '-89.90',
        FITID: '4',
        NAME: 'PAGAMENTO BOLETO',
        MEMO: 'COMPANHIA ENERGÉTICA',
      }),
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240106',
        TRNAMT: '-15.00',
        FITID: '5',
        MEMO: 'TARIFA MENSAL',
      }),
      stmttrn({
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240107',
        TRNAMT: '10.00',
        FITID: '6',
        MEMO: 'ESTORNO TARIFA',
      }),
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240108',
        TRNAMT: '-100.00',
        FITID: '7',
        MEMO: 'SAQUE CAIXA 24H',
      }),
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240109',
        TRNAMT: '-40.00',
        FITID: '8',
        MEMO: 'TRANSFERÊNCIA ENTRE CONTAS',
      }),
      stmttrn({
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240110',
        TRNAMT: '5000.00',
        FITID: '9',
        MEMO: 'SALÁRIO',
      }),
    ])}`,
  );

  it('categorizes every memo, accents and all', () => {
    expect(transactionsOf(doc).map((t) => t.category)).toEqual([
      'pix',
      'pix',
      'ted',
      'boleto',
      'tarifa',
      'estorno',
      'saque',
      'transfer',
      undefined,
    ]);
  });

  it('extracts counterparties (names with accents, masked and full documents)', () => {
    const counterparties = transactionsOf(doc).map((t) => t.counterparty);
    expect(counterparties[0]).toEqual({ name: 'MARIA DA SILVA', document: '***.123.456-**' });
    expect(counterparties[1]).toEqual({ name: 'José Mário' });
    expect(counterparties[2]).toEqual({ name: 'BANCO DO BRASIL', document: '00.000.000/0001-91' });
    expect(counterparties[3]).toEqual({ name: 'COMPANHIA ENERGÉTICA' });
    expect(counterparties[4]).toBeUndefined(); // fees carry no counterparty
    expect(counterparties[5]).toBeUndefined();
    expect(counterparties[6]).toBeUndefined(); // withdrawals carry no counterparty
    expect(counterparties[7]).toBeUndefined(); // label-only transfer memo
    expect(counterparties[8]).toBeUndefined();
  });

  it('does not rewarn or renumber ids: enrichment is silent on warnings', () => {
    expect(doc.warnings).toEqual([]);
    expect(transactionsOf(doc).map((t) => t.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('is deterministic across parses', () => {
    const text = `${MIN_HEADER}${bankBody([
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240102',
        TRNAMT: '-50.00',
        FITID: '1',
        MEMO: 'Pix enviado - MARIA DA SILVA - CPF ***.123.456-**',
      }),
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240102',
        TRNAMT: '-20.00',
        FITID: '1',
        MEMO: 'TED X',
      }),
    ])}`;
    expect(parse(text)).toEqual(parse(text));
  });
});

describe('parse — credit-card sign normalization and installments', () => {
  const doc = parse(
    `${MIN_HEADER}${cardBody([
      // Purchases emitted positive (a known Brazilian exporter quirk): flipped
      // to negative debits; installment plan detected from PARC 02/10.
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240110',
        TRNAMT: '137.90',
        FITID: 'c1',
        NAME: 'PADARIA PÃO DOCE',
        MEMO: 'COMPRA CARTAO PARC 02/10',
      }),
      // Already-negative purchase: untouched; merchant missing from NAME.
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240111',
        TRNAMT: '-50.00',
        FITID: 'c2',
        MEMO: 'Compra parcelada 3/6',
      }),
      // Refund emitted negative: flipped to a positive credit.
      stmttrn({
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240112',
        TRNAMT: '-25.00',
        FITID: 'c3',
        MEMO: 'ESTORNO DE COMPRA',
      }),
      // Card-bill payment: a genuine credit, untouched.
      stmttrn({
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240125',
        TRNAMT: '1500.00',
        FITID: 'c4',
        MEMO: 'PAGAMENTO RECEBIDO',
      }),
      // Purchase with a vague TRNTYPE: the detected category decides.
      stmttrn({
        TRNTYPE: 'OTHER',
        DTPOSTED: '20240126',
        TRNAMT: '20.00',
        FITID: 'c5',
        MEMO: 'COMPRA CARTAO MERCADO LIVRE',
      }),
    ])}`,
  );

  it('normalizes purchases to negative debits and refunds to positive credits', () => {
    const transactions = transactionsOf(doc);
    expect(transactions.map((t) => [t.amount.cents, t.direction])).toEqual([
      [B(-13790), 'debit'],
      [B(-5000), 'debit'],
      [B(2500), 'credit'],
      [B(150000), 'credit'],
      [B(-2000), 'debit'],
    ]);
  });

  it('detects installments and card-purchase categories', () => {
    const transactions = transactionsOf(doc);
    expect(transactions[0]?.installment).toEqual({ current: 2, total: 10 });
    expect(transactions[1]?.installment).toEqual({ current: 3, total: 6 });
    expect(transactions[0]?.category).toBe('card-purchase');
    expect(transactions[2]?.category).toBe('estorno');
    expect(transactions[3]?.category).toBeUndefined();
    expect(transactions[4]?.category).toBe('card-purchase');
  });

  it('takes the merchant from NAME when the memo is only the bank label', () => {
    expect(transactionsOf(doc)[0]?.counterparty).toEqual({ name: 'PADARIA PÃO DOCE' });
    expect(transactionsOf(doc)[1]?.counterparty).toBeUndefined();
    expect(transactionsOf(doc)[4]?.counterparty).toEqual({ name: 'MERCADO LIVRE' });
  });

  it('does not touch bank-statement signs in the same file (per-statement kind)', () => {
    const both = parse(
      [
        MIN_HEADER,
        '<OFX>',
        '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
        '<BANKACCTFROM><ACCTID>a</ACCTID></BANKACCTFROM>',
        '<BANKTRANLIST>',
        stmttrn({
          TRNTYPE: 'DEBIT',
          DTPOSTED: '20240101',
          TRNAMT: '100.00',
          FITID: 'b1',
          MEMO: 'COMPRA CARTÃO',
        }),
        '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>',
        '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL',
        '<CCACCTFROM><ACCTID>c</ACCTID></CCACCTFROM>',
        '<BANKTRANLIST>',
        stmttrn({
          TRNTYPE: 'DEBIT',
          DTPOSTED: '20240101',
          TRNAMT: '100.00',
          FITID: 'b2',
          MEMO: 'COMPRA CARTÃO',
        }),
        '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
        '</OFX>',
        '',
      ].join('\n'),
    );
    expect(both.warnings).toEqual([]);
    expect(transactionsOf(both, 0)[0]?.amount.cents).toBe(B(10000)); // bank: as emitted
    expect(transactionsOf(both, 1)[0]?.amount.cents).toBe(B(-10000)); // card: purchases are debits
  });
});

describe('parse — ids stay unique and deterministic with enrichment', () => {
  it('still dedupes repeated FITIDs and hashes missing ones', () => {
    const doc = parse(
      `${MIN_HEADER}${bankBody([
        stmttrn({
          TRNTYPE: 'DEBIT',
          DTPOSTED: '20240101',
          TRNAMT: '-1.00',
          FITID: 'dup',
          MEMO: 'Pix enviado FULANO',
        }),
        stmttrn({
          TRNTYPE: 'DEBIT',
          DTPOSTED: '20240102',
          TRNAMT: '-2.00',
          FITID: 'dup',
          MEMO: 'Pix recebido BELTRANO',
        }),
        stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240103', TRNAMT: '3.00', MEMO: 'TED BANCO X' }),
        stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240103', TRNAMT: '3.00', MEMO: 'TED BANCO X' }),
      ])}`,
    );
    const ids = transactionsOf(doc).map((t) => t.id);
    expect(ids.slice(0, 2)).toEqual(['dup', 'dup#2']);
    expect(ids[2]).toMatch(/^hash-[0-9a-f]{16}$/);
    expect(ids[3]).toBe(`${ids[2]}#2`); // identical fitid-less rows stay separate, silently
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['duplicate-fitid']);
    // Enrichment applies to deduped rows too.
    expect(transactionsOf(doc)[1]?.counterparty).toEqual({ name: 'BELTRANO' });
  });
});

describe('parse — verifyBalance option', () => {
  const blocks = [
    stmttrn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-10.00', FITID: 'v1' }),
    stmttrn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240102', TRNAMT: '35.00', FITID: 'v2' }),
  ];

  it('passes silently when the transaction sum equals LEDGERBAL', () => {
    const doc = parse(`${MIN_HEADER}${bankBody(blocks, '25.00')}`, { verifyBalance: true });
    expect(transactionsOf(doc).map((t) => t.amount.cents)).toEqual([B(-1000), B(3500)]);
    expect(doc.warnings).toEqual([]);
  });

  it('does not check by default', () => {
    const doc = parse(`${MIN_HEADER}${bankBody(blocks, '99.00')}`);
    expect(doc.warnings).toEqual([]);
  });

  it('warns with code, amounts and location on mismatch', () => {
    const doc = parse(`${MIN_HEADER}${bankBody(blocks, '24.00')}`, { verifyBalance: true });
    const mismatches = warningsOf(doc).filter((w) => w.code === 'balance-mismatch');
    expect(mismatches).toEqual([{ code: 'balance-mismatch', line: 27, column: 1 }]);
    // Layout: header 4 lines + blank; <OFX> line 5; two 6-line STMTTRN blocks
    // starting at line 14 end at line 25; </BANKTRANLIST> is 26, <LEDGERBAL> 27.
    const message = doc.warnings[0]?.message ?? '';
    expect(message).toContain('25.00'); // transaction sum
    expect(message).toContain('24.00'); // ledger balance
    expect(message).toContain('1.00'); // difference
  });

  it('sums card transactions after sign normalization', () => {
    const cardBlocks = [
      stmttrn({
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240110',
        TRNAMT: '137.90',
        FITID: 'k1',
        MEMO: 'COMPRA CARTAO PARC 02/10',
      }),
      stmttrn({
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240125',
        TRNAMT: '1500.00',
        FITID: 'k2',
        MEMO: 'PAGAMENTO',
      }),
    ];
    const doc = parse(`${MIN_HEADER}${cardBody(cardBlocks, '1362.10')}`, { verifyBalance: true });
    expect(transactionsOf(doc).map((t) => t.amount.cents)).toEqual([B(-13790), B(150000)]);
    expect(doc.warnings).toEqual([]); // -137.90 + 1500.00 = 1362.10 ✓
  });

  it('does not check statements without a parsable ledger balance', () => {
    const doc = parse(`${MIN_HEADER}${bankBody(blocks)}`, { verifyBalance: true });
    expect(doc.warnings).toEqual([]);
  });

  it('reports a mismatch for an empty statement with a nonzero balance', () => {
    const doc = parse(`${MIN_HEADER}${bankBody([], '5.00')}`, { verifyBalance: true });
    expect(warningsOf(doc).map((w) => w.code)).toEqual(['balance-mismatch']);
  });

  it('throws in strict mode on a mismatch', () => {
    const options: ParseOptions = { strict: true, verifyBalance: true };
    expect(() => parse(`${MIN_HEADER}${bankBody(blocks, '24.00')}`, options)).toThrow(
      OfxParseError,
    );
    try {
      parse(`${MIN_HEADER}${bankBody(blocks, '24.00')}`, options);
    } catch (error) {
      if (error instanceof OfxParseError) {
        expect(error.code).toBe('balance-mismatch');
        expect(error.line).toBe(27);
        return;
      }
      throw error;
    }
    throw new Error('expected strict verifyBalance to throw OfxParseError');
  });
});
