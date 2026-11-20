/**
 * Regression tests for the independent review (milestone 8).
 *
 * Every expected value below is hand-derived from SPEC.md, from the OFX
 * payload written in the test, or from ordinary arithmetic. Nothing here is
 * copied from the library's own output and no snapshot is accepted without
 * being read.
 */
import { describe, expect, it } from 'vitest';
import {
  enrichTransaction,
  extractCounterparty as extract,
  parse,
  parseAmountToCents,
  parseOfxDateTime,
  parseSgml,
  parseTimeZoneOffset,
  toCsv,
  type Transaction,
} from '../src/index.js';
import { runCli, type CliIO } from '../src/node/cli.js';
import { utf8Bytes } from './helpers.js';

// ------------------------------------------------------------------ builders

interface TestRow {
  fitid?: string;
  date?: string;
  amount: string;
  memo?: string;
  name?: string;
  type?: string;
  extraLeaves?: string;
}

/** A minimal OFX 1.x document from hand-written rows (all tags closed). */
function bankOfx(rows: readonly TestRow[]): string {
  const body = rows
    .map((row) => {
      const fitid = row.fitid === undefined ? '' : `<FITID>${row.fitid}</FITID>`;
      const memo = row.memo === undefined ? '' : `<MEMO>${row.memo}</MEMO>`;
      const name = row.name === undefined ? '' : `<NAME>${row.name}</NAME>`;
      return (
        `<STMTTRN><TRNTYPE>${row.type ?? 'DEBIT'}</TRNTYPE>` +
        `<DTPOSTED>${row.date ?? '20240101'}</DTPOSTED>` +
        `<TRNAMT>${row.amount}</TRNAMT>${fitid}${name}${memo}${row.extraLeaves ?? ''}</STMTTRN>`
      );
    })
    .join('');
  return (
    'OFXHEADER:100\nVERSION:102\nENCODING:USASCII\n\n\n' +
    `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL` +
    `<BANKACCTFROM><BANKID>001</BANKID><ACCTID>acc-1</ACCTID></BANKACCTFROM>` +
    `<BANKTRANLIST>${body}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
  );
}

/** Injectable CLI I/O with an explicit stdin buffer. */
function fakeIO(
  files: Record<string, Uint8Array>,
  stdin: Uint8Array = new Uint8Array(0),
): CliIO & {
  stdoutText: string;
  stderrText: string;
} {
  const io = {
    stdoutText: '',
    stderrText: '',
    bytes: stdin,
    readFile(path: string): Uint8Array {
      const value = files[path];
      if (value === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return value;
    },
    readStdin(): Uint8Array {
      return io.bytes;
    },
    writeFile(): void {
      /* not used */
    },
    stdout(text: string): void {
      io.stdoutText += text;
    },
    stderr(text: string): void {
      io.stderrText += text;
    },
  };
  return io;
}

interface CliRow {
  id: string;
  fitid?: string;
  amount: { cents: string };
  description: string;
}

function cliRows(io: { stdoutText: string }): CliRow[] {
  const docs = JSON.parse(io.stdoutText) as {
    statements: { transactions: CliRow[] }[];
  }[];
  return docs.flatMap((doc) => doc.statements.flatMap((statement) => statement.transactions));
}

// -------------------------------------------------------- finding 1: dedupe

describe('review finding 1 — CLI dedupe/merge must not drop distinct transactions', () => {
  it('--dedupe keeps two distinct rows that share a FITID (MERCADO -10, FARMACIA -99)', () => {
    // Hand-derived: two different purchases, both with FITID "000" because the
    // exporter restarts its sequence. They are distinct transactions.
    const bytes = utf8Bytes(
      bankOfx([
        { fitid: '000', date: '20240105', amount: '-10.00', memo: 'MERCADO' },
        { fitid: '000', date: '20240106', amount: '-99.00', memo: 'FARMACIA' },
      ]),
    );
    const io = fakeIO({ 'dup.ofx': bytes });
    expect(runCli(['dup.ofx', '--dedupe'], io)).toBe(0);
    expect(cliRows(io).map((row) => [row.description, row.amount.cents])).toEqual([
      ['MERCADO', '-1000'],
      ['FARMACIA', '-9900'],
    ]);
  });

  it('--merge keeps February rows when both files restart FITIDs at 1', () => {
    // Jan file: FITID 1, -10.00 on Jan 5. Feb file: FITID 1, -20.00 on Feb 5.
    // The ONLY correct result is two rows; dropping Feb loses R$ 20.00.
    const jan = utf8Bytes(
      bankOfx([{ fitid: '1', date: '20240105', amount: '-10.00', memo: 'JANEIRO' }]),
    );
    const feb = utf8Bytes(
      bankOfx([{ fitid: '1', date: '20240205', amount: '-20.00', memo: 'FEVEREIRO' }]),
    );
    const io = fakeIO({ 'jan.ofx': jan, 'feb.ofx': feb });
    expect(runCli(['jan.ofx', 'feb.ofx', '--merge'], io)).toBe(0);
    expect(cliRows(io).map((row) => [row.description, row.amount.cents])).toEqual([
      ['JANEIRO', '-1000'],
      ['FEVEREIRO', '-2000'],
    ]);
  });

  it('--dedupe still drops a genuinely identical row (same account, date, amount, memo)', () => {
    const row: TestRow = { fitid: 'X', date: '20240105', amount: '-10.00', memo: 'MERCADO' };
    const io = fakeIO({ 'dup.ofx': utf8Bytes(bankOfx([row, row])) });
    expect(runCli(['dup.ofx', '--dedupe'], io)).toBe(0);
    expect(cliRows(io)).toHaveLength(1);
    expect(io.stderrText).toContain('[duplicate-transaction-dropped]');
  });
});

// ---------------------------------------------------------- finding 2: money

describe('review finding 2 — leading-zero decimal fractions and ambiguity', () => {
  it('treats a leading-zero integer part as a decimal, not a thousands group', () => {
    // 0.125 reais = 12.5 cents → 13 (half away from zero); -0.500 = -50;
    // 0,005 reais = 0.5 cents → 1. All hand-derived from the decimal value.
    expect(parseAmountToCents('0.125')).toBe(13n);
    expect(parseAmountToCents('-0.500')).toBe(-50n);
    expect(parseAmountToCents('0,005')).toBe(1n);
    expect(parseAmountToCents('0,125')).toBe(13n);
  });

  it('keeps the documented thousands rule for non-leading-zero integers and warns', () => {
    const warnings: { code: string; message: string }[] = [];
    const cents = parseAmountToCents('10.500', (warning) => warnings.push(warning));
    // 10.500 with a single dot is ambiguous: keep the SPEC thousands reading
    // (10,500 reais = 1,050,000 cents) and flag it for the caller.
    expect(cents).toBe(1_050_000n);
    expect(warnings.map((warning) => warning.code)).toEqual(['amount-ambiguous']);

    const clean: string[] = [];
    expect(parseAmountToCents('0.125', (warning) => clean.push(warning.code))).toBe(13n);
    expect(clean).toEqual([]); // a leading zero is unambiguous
  });
});

// ---------------------------------------------------------- finding 3: CDATA

describe('review finding 3 — CDATA sections', () => {
  it('keeps CDATA content verbatim in the tree', () => {
    const tree = parseSgml('<MEMO><![CDATA[A & <B>]]></MEMO>');
    const memo = tree.root.children.find((element) => element.name === 'MEMO');
    expect(memo?.text).toBe('A & <B>');
    expect(tree.warnings.map((warning) => warning.code)).toEqual([]);
  });

  it('maps CDATA with raw & and < into the transaction memo', () => {
    const bytes = utf8Bytes(
      bankOfx([{ fitid: 'c1', amount: '-1.00', memo: '<![CDATA[A & <B>]]>' }]),
    );
    const doc = parse(new TextDecoder().decode(bytes));
    expect(doc.statements[0]?.transactions[0]?.memo).toBe('A & <B>');
  });
});

// ------------------------------------------------------- finding 4: datetime

describe('review finding 4 — fractional timezone offsets', () => {
  it('converts decimal offset hours to minutes (hand-derived)', () => {
    // +5.5 h = +5 h 30 min = 330 min; -3.5 h = -210 min; +5.75 h = +345 min.
    expect(parseOfxDateTime('20240115120000[+5.5:IST]').offsetMinutes).toBe(330);
    expect(parseOfxDateTime('20240115120000[+5.5:IST]').iso).toBe('2024-01-15T12:00:00+05:30');
    expect(parseOfxDateTime('20240115120000[-3.5]').offsetMinutes).toBe(-210);
    expect(parseOfxDateTime('20240115120000[-3.5]').iso).toBe('2024-01-15T12:00:00-03:30');
    expect(parseOfxDateTime('20240115120000[+5.75:IST]').offsetMinutes).toBe(345);
  });

  it('accepts decimal hours in the --tz option too', () => {
    expect(parseTimeZoneOffset('+5.5')).toBe(330);
    expect(parseTimeZoneOffset('-3.5')).toBe(-210);
  });
});

// ------------------------------------------- findings 5 & 6: counterparties

describe('review findings 5 and 6 — counterparty cleanup', () => {
  it('strips prefixes, quotes, trailing dates and DES:/REM: markers', () => {
    // Expected names are the human part of each memo, read by hand.
    expect(extract('Pix enviado: "Padaria"')).toEqual({ name: 'Padaria' });
    expect(extract('PIX TRANSF JOAO SILVA 15/01')).toEqual({ name: 'JOAO SILVA' });
    expect(extract('TRANSFERENCIA PIX DES: FULANO')).toEqual({ name: 'FULANO' });
    expect(extract('PIX ENVIADO REM: MARIA SOUZA')).toEqual({ name: 'MARIA SOUZA' });
  });

  it('does not reject a business name that contains a four-digit token', () => {
    // "2000" is part of the merchant name, not an account or document number.
    expect(extract('PIX ENVIADO PADARIA 2000 LTDA')).toEqual({ name: 'PADARIA 2000 LTDA' });
    // Long digit runs and leading-zero account-like tokens are still rejected.
    expect(extract('PAGAMENTO BOLETO NUMERO 12345 ESTORNO TARIFA BANCARIA')).toBeUndefined();
  });
});

// --------------------------------------- findings 7 & 8: lenient tree/mapper

describe('review finding 7 — unclosed LEDGERBAL must not swallow AVAILBAL', () => {
  it('recovers the sibling balance and emits a specific warning', () => {
    const text = [
      'OFXHEADER:100\nVERSION:102\nENCODING:USASCII\n\n\n',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
      '<BANKACCTFROM><ACCTID>acc-1</ACCTID></BANKACCTFROM>',
      '<LEDGERBAL><BALAMT>100.00<DTASOF>20240131',
      '<AVAILBAL><BALAMT>90.00<DTASOF>20240131</AVAILBAL>',
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('');
    const doc = parse(text);
    const statement = doc.statements[0];
    // Hand-derived from the two BALAMT leaves above.
    expect(statement?.ledgerBalance?.amount.cents).toBe(10_000n);
    expect(statement?.availableBalance?.amount.cents).toBe(9_000n);
    expect(doc.warnings.map((warning) => warning.code)).toContain('implicit-sibling-close');
  });
});

describe('review finding 8 — repeated leaf fields are not silently discarded', () => {
  it('warns when a STMTTRN repeats a leaf and keeps the first value', () => {
    const doc = parse(
      bankOfx([
        {
          fitid: 'r1',
          amount: '-10.00',
          extraLeaves: '<MEMO>PRIMEIRO</MEMO><MEMO>SEGUNDO</MEMO>',
        },
      ]),
    );
    expect(doc.statements[0]?.transactions[0]?.memo).toBe('PRIMEIRO');
    const repeated = doc.warnings.filter((warning) => warning.code === 'repeated-leaf');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.message).toContain('MEMO');
  });
});

// ---------------------------------------------- findings 9 & 10: transparency

describe('review finding 9 — card sign normalization is visible', () => {
  it('keeps the raw emitted amount and emits an info warning on a flip', () => {
    const tx: Transaction = {
      id: 'c1',
      type: 'DEBIT',
      direction: 'debit',
      amount: { cents: 13_790n, currency: 'BRL' },
      postedAt: '2024-01-05',
      description: 'COMPRA CARTAO',
    };
    const warnings: { code: string; message: string }[] = [];
    enrichTransaction(tx, 'creditcard', (warning) => warnings.push(warning));
    // Purchases are debits: +137.90 → -137.90, but the raw value survives.
    expect(tx.amount.cents).toBe(-13_790n);
    expect(tx.rawAmount).toEqual({ cents: 13_790n, currency: 'BRL' });
    expect(warnings.map((warning) => warning.code)).toEqual(['card-sign-normalized']);
  });

  it('relays that warning through the full parse pipeline', () => {
    const text = [
      'OFXHEADER:100\nVERSION:102\nENCODING:USASCII\n\n\n',
      '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL',
      '<CCACCTFROM><ACCTID>card</ACCTID></CCACCTFROM><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105<TRNAMT>137.90<FITID>c1<MEMO>COMPRA CARTAO</STMTTRN>',
      '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('');
    const doc = parse(text);
    const tx = doc.statements[0]?.transactions[0];
    expect(tx?.amount.cents).toBe(-13_790n);
    expect(tx?.rawAmount?.cents).toBe(13_790n);
    expect(doc.warnings.map((warning) => warning.code)).toContain('card-sign-normalized');
  });
});

describe('review finding 10 — missing FITID warns when the hash is used', () => {
  it('reports that the content hash stands in for a FITID', () => {
    const doc = parse(bankOfx([{ amount: '-10.00', date: '20240105', memo: 'SEM FITID' }]));
    const tx = doc.statements[0]?.transactions[0];
    expect(tx?.fitid).toBeUndefined();
    expect(tx?.id).toMatch(/^hash-[0-9a-f]{16}$/);
    const warning = doc.warnings.find((entry) => entry.code === 'missing-fitid');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('hash');
  });
});

// --------------------------------------------------- finding 14: CSV formula

describe('review finding 14 — CSV formula injection', () => {
  it('prefixes formula-like cells but never numeric amounts', () => {
    const doc = parse(
      bankOfx([
        { fitid: 'f1', amount: '-1234.56', memo: '=1+1' },
        { fitid: 'f2', amount: '-10.00', memo: '@SUM(A1:A9)' },
        { fitid: 'f3', amount: '-20.00', memo: '+cmd' },
        { fitid: 'f4', amount: '-30.00', memo: '-FOO' },
      ]),
    );
    const csv = toCsv(doc, { bom: true });
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM(A1:A9)");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-FOO");
    // A negative amount is a number, not a formula: it must stay untouched.
    expect(csv).toContain('-1234.56');
    expect(csv).not.toContain("'-1234.56");
  });

  it('can be turned off explicitly', () => {
    const doc = parse(bankOfx([{ fitid: 'f1', amount: '-10.00', memo: '=1+1' }]));
    expect(toCsv(doc, { escapeFormulas: false })).toContain(',=1+1,');
  });
});

// ------------------------------------------------------- finding 15: CLI I/O

describe('review finding 15 — stdin and invalid --tz', () => {
  it("reads the document from stdin when the input file is '-'", () => {
    const io = fakeIO({}, utf8Bytes(bankOfx([{ fitid: 's1', amount: '-10.00', memo: 'STDIN' }])));
    expect(runCli(['-'], io)).toBe(0);
    expect(cliRows(io).map((row) => row.description)).toEqual(['STDIN']);
  });

  it('exits 2 on an invalid --tz value', () => {
    const io = fakeIO({ 'a.ofx': utf8Bytes(bankOfx([])) });
    expect(runCli(['a.ofx', '--tz', 'America/Sao_Paulo'], io)).toBe(2);
    expect(io.stderrText).toContain('invalid');
    expect(io.stdoutText).toBe('');
  });
});
