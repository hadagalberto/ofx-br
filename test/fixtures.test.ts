/**
 * Milestone-5 fixture corpus.
 *
 * Every `.ofx` file in `test/fixtures/` is a synthetic, fake-data export
 * modeled after a commonly observed quirk of a Brazilian bank OFX. Each one
 * has a matching `.expected.json` holding its complete normalized document
 * (exact cents as decimal strings, warning codes, enrichment) and the parse
 * options needed to reproduce it.
 *
 * The `matches its expected document` cases are explicit expected-output
 * tests. The `known-valid/known-invalid vectors` cases assert hand-derived
 * values independently, so a parser regression cannot be "snapshotted away".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeOfx, OfxParseError, parse, parseBuffer } from '../src/index.js';
import type { Money, OfxDocument, ParseOptions, Transaction } from '../src/index.js';

const FIXTURES_DIR = join(process.cwd(), 'test', 'fixtures');

interface ExpectedFixture {
  options?: ParseOptions;
  document: unknown;
}

function readExpected(name: string): ExpectedFixture {
  const path = join(FIXTURES_DIR, `${name}.expected.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedFixture;
}

function load(name: string): OfxDocument {
  const bytes = readFileSync(join(FIXTURES_DIR, `${name}.ofx`));
  return parseBuffer(bytes, readExpected(name).options ?? {});
}

function transactions(document: OfxDocument): Transaction[] {
  return document.statements.flatMap((statement) => statement.transactions);
}

function cents(document: OfxDocument): string[] {
  return transactions(document).map((transaction) => transaction.amount.cents.toString());
}

function moneyView(value: Money | undefined): { cents: string; currency: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  return { cents: value.cents.toString(), currency: value.currency };
}

/** Full canonical document, identical in shape to the `.expected.json` files. */
function canonical(document: OfxDocument): unknown {
  return {
    header: document.header,
    version: document.version,
    encoding: document.encoding,
    signOn: document.signOn,
    statements: document.statements.map((statement) => ({
      kind: statement.kind,
      currency: statement.currency,
      account: statement.account,
      period: statement.period,
      ledgerBalance:
        statement.ledgerBalance === undefined
          ? undefined
          : {
              amount: moneyView(statement.ledgerBalance.amount),
              date: statement.ledgerBalance.date,
            },
      availableBalance:
        statement.availableBalance === undefined
          ? undefined
          : {
              amount: moneyView(statement.availableBalance.amount),
              date: statement.availableBalance.date,
            },
      transactions: statement.transactions.map((transaction) => ({
        id: transaction.id,
        fitid: transaction.fitid,
        type: transaction.type,
        direction: transaction.direction,
        amount: moneyView(transaction.amount),
        rawAmount:
          transaction.rawAmount === undefined ? undefined : moneyView(transaction.rawAmount),
        postedAt: transaction.postedAt,
        userDate: transaction.userDate,
        description: transaction.description,
        name: transaction.name,
        memo: transaction.memo,
        checkNumber: transaction.checkNumber,
        refNumber: transaction.refNumber,
        category: transaction.category,
        counterparty: transaction.counterparty,
        installment: transaction.installment,
      })),
    })),
    warningCodes: document.warnings.map((warning) => warning.code),
  };
}

const FIXTURE_FILES = readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith('.ofx'))
  .sort();

describe('fixture corpus — expected output', () => {
  it('contains at least 25 synthetic OFX files, each with exactly one expected document', () => {
    expect(FIXTURE_FILES.length).toBeGreaterThanOrEqual(25);
    // The old `endsWith('.ofx')` assertion was a tautology over an already
    // filtered list. Compare the two stem sets instead: this catches orphan
    // snapshots and fixtures whose expected document is missing.
    const expectedStems = readdirSync(FIXTURES_DIR)
      .filter((file) => file.endsWith('.expected.json'))
      .map((file) => file.replace(/\.expected\.json$/, ''))
      .sort();
    const fixtureStems = FIXTURE_FILES.map((file) => file.replace(/\.ofx$/, '')).sort();
    expect(fixtureStems).toEqual(expectedStems);
    for (const stem of fixtureStems) {
      expect(readExpected(stem).document).toBeDefined();
    }
  });

  it.each(FIXTURE_FILES)('%s parses to its expected document', (file) => {
    const bytes = readFileSync(join(FIXTURES_DIR, file));
    const expected = readExpected(file.replace(/\.ofx$/, ''));
    expect(canonical(parseBuffer(bytes, expected.options ?? {}))).toEqual(expected.document);
  });
});

describe('fixture corpus — known-valid and known-invalid vectors', () => {
  it('01: Itaú SGML/1252 — accents, entities, unclosed leaves and Pix counterparty', () => {
    const doc = load('01-itau-sgml-1252');
    expect(doc.version).toBe('1');
    expect(doc.encoding).toBe('windows-1252');
    expect(doc.statements[0]?.account.bankName).toBe('ITAÚ UNIBANCO S.A.');
    expect(doc.warnings).toEqual([]);
    expect(transactions(doc)[0]?.memo).toBe('COMPANHIA ENERGÉTICA & FILHOS LTDA');
    expect(transactions(doc)[0]?.category).toBe('boleto');
    expect(transactions(doc)[3]?.counterparty).toEqual({
      name: 'MARIA APARECIDA SOUZA',
      document: '***.123.456-**',
    });
    expect(doc.statements[0]?.ledgerBalance?.amount.cents).toBe(123456n);
  });

  it('02: Bradesco comma decimals and BRT offsets', () => {
    const doc = load('02-bradesco-brt-lf');
    expect(cents(doc)).toEqual(['-250000', '-10000', '-4590', '1234']);
    expect(transactions(doc)[0]?.postedAt).toBe('2024-02-01T10:00:00-03:00');
    expect(transactions(doc)[1]?.checkNumber).toBe('000123');
  });

  it('03/25: card purchases are debits, refunds are credits, installments detected', () => {
    const nubank = transactions(load('03-nubank-card-xml'));
    expect(nubank[0]?.amount.cents).toBe(-13790n); // emitted positive, flipped
    expect(nubank[0]?.direction).toBe('debit');
    expect(nubank[1]?.installment).toEqual({ current: 2, total: 10 });
    expect(nubank[2]?.amount.cents).toBe(5000n); // emitted negative, flipped
    expect(nubank[2]?.direction).toBe('credit');

    const card = transactions(load('25-card-signs-installments'));
    expect(card[5]?.installment).toEqual({ current: 12, total: 48 });
    expect(card[5]?.counterparty).toBeUndefined(); // PARC12/48 is not a merchant
    expect(card[6]).toMatchObject({
      amount: { cents: 2500n },
      direction: 'credit', // estorno wins over a mislabelled TRNTYPE>DEBIT
      category: 'estorno',
    });
  });

  it('04/05/06: Inter XML 2.x, Caixa grouping and BB mojibake repair', () => {
    expect(load('04-inter-xml-utf8').version).toBe('2');
    expect(load('04-inter-xml-utf8').header.OFXHEADER).toBe('200');
    expect(cents(load('05-caixa-comma-decimals'))).toEqual([
      '-123456',
      '250000',
      '1000',
      '3500000',
    ]);
    const bb = load('06-bb-mojibake-utf8');
    expect(bb.encoding).toBe('utf-8');
    expect(bb.warnings.map((warning) => warning.code)).toContain('mojibake-repaired');
    expect(transactions(bb)[2]?.memo).toContain('ELÉTRICA'); // not "ELÃ‰TRICA"
  });

  it('07: multiple statements in one file, FITIDs scoped per statement', () => {
    const doc = load('07-multi-statements');
    expect(doc.statements.map((statement) => statement.kind)).toEqual([
      'bank',
      'bank',
      'creditcard',
    ]);
    expect(transactions(doc).map((transaction) => transaction.id)).toEqual([
      'tx-1',
      'tx-1',
      'cc-1',
    ]);
    expect(doc.warnings).toEqual([]);
  });

  it('08: truncated file keeps complete rows and hashes the FITID-less tail', () => {
    const doc = load('08-truncated-mid-stmttrn');
    expect(transactions(doc)).toHaveLength(3);
    expect(transactions(doc)[2]?.id).toMatch(/^hash-[0-9a-f]{16}$/);
    expect(transactions(doc)[2]?.amount.cents).toBe(-4210n);
    // Independent review: the hash used for the FITID-less tail is now warned
    // about; every other warning is still an unclosed aggregate.
    expect(doc.warnings.filter((warning) => warning.code === 'missing-fitid')).toHaveLength(1);
    expect(
      doc.warnings
        .filter((warning) => warning.code !== 'missing-fitid')
        .every((warning) => warning.code === 'unclosed-aggregate'),
    ).toBe(true);
  });

  it('09: duplicate FITIDs are kept and made unique deterministically', () => {
    const doc = load('09-duplicate-fitids');
    expect(transactions(doc).map((transaction) => transaction.id)).toEqual([
      'DUP',
      'DUP#2',
      'DUP#3',
      'hash-310efd371a1304d0',
    ]);
    // Independent review: the FITID-less fourth row additionally reports the
    // content-hash substitution; the old two-warning assertion was incomplete.
    expect(doc.warnings.map((warning) => warning.code)).toEqual([
      'duplicate-fitid',
      'duplicate-fitid',
      'missing-fitid',
    ]);
  });

  it('10/11: empty transaction list and one-huge-line exports', () => {
    const empty = load('10-empty-banktranlist');
    expect(empty.statements[0]?.transactions).toEqual([]);
    expect(empty.statements[0]?.period).toEqual({ start: '2024-01-01', end: '2024-01-31' });
    const huge = load('11-huge-single-line');
    expect(transactions(huge).map((transaction) => transaction.amount.cents)).toEqual([
      -2590n,
      320000n,
    ]);
  });

  it('12/13: lowercase and mixed-case tags normalize to the same model', () => {
    const lower = load('12-lowercase-tags');
    expect(transactions(lower)[0]?.type).toBe('debit'); // raw TRNTYPE value preserved
    expect(transactions(lower)[0]?.direction).toBe('debit');
    const mixed = load('13-mixed-case-tags');
    expect(mixed.statements[0]?.account.bankId).toBe('403');
    expect(cents(mixed)).toEqual(['-8844', '59900']);
  });

  it('14: entities decode, raw & survives and unknown entities warn', () => {
    const doc = load('14-entities-raw-ampersand');
    const rows = transactions(doc);
    expect(rows[0]?.memo).toBe('MERCADO & CIA LTDA');
    expect(rows[1]?.memo).toBe('ATENCAO <VALOR> LIMITE 100');
    expect(rows[2]?.memo).toBe('LETRAS ABC FINAL');
    expect(rows[3]?.memo).toBe('BAR & LANCHONETE EXPRESS');
    expect(rows[4]?.memo).toBe('PAGAMENTO &foo; PENDENTE');
    expect(rows[5]?.memo).toBe('TARIFA MENSAL'); // &nbsp; collapsed
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['unknown-entity']);
  });

  it('15: NUL bytes are stripped with one warning; corrupt tag loses only its memo', () => {
    const doc = load('15-nul-bytes');
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['nul-byte']);
    expect(transactions(doc)[0]?.memo).toBeUndefined();
    expect(cents(doc)).toEqual(['-1200', '10000', '1050']); // `10\0,50` → R$ 10,50
  });

  it('16/17/18/19: CR-only endings, trailing garbage, no header, garbage header', () => {
    const cr = load('16-cr-only-line-endings');
    expect(transactions(cr)).toHaveLength(2); // `****` amount row skipped
    expect(cr.warnings.map((warning) => warning.code)).toEqual(['invalid-amount']);
    expect(load('17-trailing-garbage').warnings.map((warning) => warning.code)).toEqual([
      'trailing-garbage',
    ]);
    const noHeader = load('18-no-header-body-only');
    expect(noHeader.version).toBe('unknown');
    expect(noHeader.warnings.map((warning) => warning.code)).toEqual(['missing-header']);
    const garbage = load('19-garbage-header');
    expect(garbage.version).toBe('unknown');
    expect(garbage.statements[0]?.account.bankName).toBe('BCO C6 S.A.');
  });

  it('20/21: UTF-16 BOM and ISO-8859-1 C1 repair', () => {
    const utf16 = load('20-utf16le-bom');
    expect(utf16.encoding).toBe('utf-16le');
    expect(transactions(utf16)[0]?.memo).toContain('TARIFAÇÃO');
    const latin = load('21-iso88591-c1-repair');
    expect(latin.encoding).toBe('iso-8859-1');
    expect(latin.warnings.map((warning) => warning.code)).toEqual(['latin1-c1-repaired']);
    expect(transactions(latin)[0]?.memo).toBe('TARIFA MANUTENÇÃO …');
  });

  it('22: every amount convention maps to exact integer cents', () => {
    const doc = load('22-amount-conventions');
    expect(cents(doc)).toEqual([
      '-123456', // -1234.56
      '-123456', // -1234,56
      '123456', // 1.234,56
      '123456', // 1,234.56
      '1000', // +10
      '1000', // R$ 10,00
      '250000', // 2.500 (grouped thousands)
      '3500000', // 35.000,00
      '50', // ,50
      '123', // 1,2345 (half-up rounding)
    ]);
    expect(transactions(doc)).toHaveLength(10); // `N/D` and missing TRNAMT skipped
    // "2.500" is a single separator with three digits: the documented
    // thousands reading is kept but is now flagged as ambiguous (review).
    expect(doc.warnings.map((warning) => warning.code)).toEqual([
      'amount-ambiguous',
      'invalid-amount',
      'invalid-amount',
    ]);
  });

  it('23: date suffixes, clamping and hopeless values', () => {
    const rows = transactions(load('23-date-conventions'));
    expect(rows.map((row) => row.postedAt)).toEqual([
      '2024-01-15',
      '2024-01-15T12:00:00-03:00',
      '2024-01-15T12:00:00-03:00',
      '2024-01-15T12:00:00.500-03:00',
      '2024-01-15T12:00:00-03:00', // [-03:EST] name ignored
      '2024-01-15T12:00:00+00:00', // [0:GMT]
      '2024-01-15T12:00:00-03:00', // [-3]
      '2024-01-15T12:00:00+05:30',
      '2024-02-29', // 20240230 clamped, never NaN
      '2024-12-01T00:00:00-03:00', // month 13 clamped
      '', // 15/01/2024 is not an OFX date
    ]);
  });

  it('24: categories, CPF/CNPJ (full, masked, bare) and counterparty names', () => {
    const rows = transactions(load('24-pix-enrichment-zoo'));
    expect(rows.map((row) => row.category)).toEqual([
      'pix',
      'pix',
      'pix',
      'ted',
      'doc',
      'boleto',
      'tarifa',
      'iof',
      'juros',
      'estorno',
      'saque',
      'transfer',
      'card-purchase',
    ]);
    expect(rows[0]?.counterparty).toEqual({
      name: 'MARIA APARECIDA SOUZA',
      document: '123.456.789-09',
    });
    expect(rows[1]?.counterparty?.document).toBe('***.238.624-**');
    expect(rows[2]?.counterparty).toEqual({ document: '52998224725' });
    expect(rows[3]?.counterparty?.document).toBe('11.222.333/0001-81');
    expect(rows[6]?.counterparty).toBeUndefined(); // fees have no counterparty
  });

  it('26/27/28: balance verification, status problems and wrapper-less bodies', () => {
    const mismatch = load('26-balance-mismatch');
    expect(mismatch.warnings.map((warning) => warning.code)).toEqual(['balance-mismatch']);
    const defaultOptions = parseBuffer(readFileSync(join(FIXTURES_DIR, '26-balance-mismatch.ofx')));
    expect(defaultOptions.warnings).toEqual([]); // verifyBalance off by default
    const statuses = load('27-statement-error-status');
    expect(statuses.statements).toHaveLength(2); // the error-only response was skipped
    expect(statuses.warnings.map((warning) => warning.code)).toEqual([
      'statement-error',
      'statement-status-error',
      'missing-trntype',
    ]);
    const wrapperless = load('28-wrapperless-body');
    expect(wrapperless.header).toEqual({});
    expect(wrapperless.statements[0]?.account.bankName).toBe('BANCO INTER');
  });

  it('29/30: CHECKNUM/REFNUM/DTUSER and stray whitespace/newlines in values', () => {
    const santander = transactions(load('29-santander-checknum'));
    expect(santander[0]).toMatchObject({
      checkNumber: '000123',
      refNumber: 'SN-991',
      userDate: '2024-01-04',
    });
    const padded = transactions(load('30-stray-whitespace-values'));
    expect(padded[0]?.name).toBe('PAGAMENTO BOLETO NUMERO 12345');
    expect(padded[0]?.memo).toBe('ESTORNO TARIFA BANCARIA');
    expect(padded[0]?.amount.cents).toBe(-1050n);
    expect(padded[0]?.counterparty).toBeUndefined(); // numeric fragments are not names
  });

  it('31/32/33/34/35: duplicate/stray close tags, one-line header, empty file, comment', () => {
    expect(load('31-duplicated-closing-tags').warnings).toHaveLength(5);
    const oneLine = load('32-one-line-header');
    expect(oneLine.header.OFXHEADER).toBe('100');
    expect(oneLine.header.NEWFILEUID).toBe('NONE');
    const empty = load('33-empty');
    expect(empty.statements).toEqual([]);
    expect(empty.warnings.map((warning) => warning.code)).toEqual(['missing-header']);
    expect(load('34-stray-close-tag').warnings.map((warning) => warning.code)).toEqual([
      'stray-close-tag',
    ]);
    expect(load('35-unterminated-comment').warnings.map((warning) => warning.code)).toEqual([
      'unterminated-comment',
    ]);
  });

  it('36/37/38: missing metadata, caller timezone and missing optional fields', () => {
    const missing = load('36-missing-metadata');
    expect(missing.statements[0]?.currency).toBe('XXX');
    expect(missing.statements[0]?.account.accountId).toBe('');
    expect(missing.signOn?.statusCode).toBe(0);
    expect(missing.warnings.map((warning) => warning.code)).toEqual([
      'invalid-status-code',
      'missing-currency',
      'missing-account-id',
    ]);
    const tz = transactions(load('37-custom-timezone'));
    expect(tz.map((row) => row.postedAt)).toEqual([
      '2024-01-05T09:00:00+02:00',
      '2024-01-10T12:00:00+02:00',
    ]);
    const fields = transactions(load('38-missing-optional-fields'));
    expect(fields[0]).toMatchObject({ type: '', postedAt: '2024-01-05', direction: 'debit' });
    expect(fields[1]?.postedAt).toBe('');
    expect(fields.slice(2).map((row) => row.direction)).toEqual(['credit', 'debit']);
  });

  it('strict mode throws OfxParseError with a source location on the first problem', () => {
    const bytes = readFileSync(join(FIXTURES_DIR, '15-nul-bytes.ofx'));
    const text = decodeOfx(bytes).text;
    expect(() => parse(text, { strict: true })).toThrow(OfxParseError);
    try {
      parse(text, { strict: true });
      expect.unreachable('strict parse should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OfxParseError);
      const failure = error as OfxParseError;
      expect(failure.code).toBe('nul-byte');
      expect(failure.line).toBeGreaterThan(0);
      expect(failure.column).toBeGreaterThan(0);
    }
  });
});
