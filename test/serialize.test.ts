import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CSV_COLUMNS,
  UTF8_BOM,
  toCsv,
  toJson,
  validateDelimiter,
  type CsvLocale,
} from '../src/serialize.js';
import { parseBuffer } from '../src/parse.js';
import type { OfxDocument } from '../src/model.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', '01-itau-sgml-1252.ofx');

function fixtureDocument(): OfxDocument {
  return parseBuffer(new Uint8Array(readFileSync(FIXTURE)));
}

/** Minimal RFC 4180 row parser for assertions (handles quoted commas, quotes and newlines). */
function parseCsvRow(row: string, delimiter = ','): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row.charAt(i);
    if (char === '"') {
      if (quoted && row.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** Minimal real document for hand-tuned CSV fields. */
function oneTransactionDocument(description: string, cents = -123456n): OfxDocument {
  const document = parseBuffer(
    new TextEncoder().encode(
      [
        'OFXHEADER:100',
        'DATA:OFXSGML',
        'VERSION:102',
        'ENCODING:USASCII',
        'CHARSET:NONE',
        '',
        '',
        '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>',
        '<BANKACCTFROM><BANKID>341</BANKID><ACCTID>1</ACCTID></BANKACCTFROM>',
        '<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240105</DTPOSTED>',
        '<TRNAMT>-1234.56</TRNAMT><FITID>A1</FITID><MEMO>X</MEMO></STMTTRN>',
        '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
      ].join('\r\n'),
    ),
  );
  const transaction = document.statements[0]?.transactions[0];
  if (transaction === undefined) {
    throw new Error('test document has no transaction');
  }
  transaction.description = description;
  transaction.amount.cents = cents;
  return document;
}

describe('toJson', () => {
  it('serializes bigint cents as exact decimal strings', () => {
    const json = toJson(fixtureDocument());
    expect(json).toContain('"cents": "123456"');
    expect(json).toContain('"cents": "-8990"');
    expect(json).toContain('"currency": "BRL"');
    expect(() => {
      JSON.parse(json) as unknown;
    }).not.toThrow();
  });

  it('keeps cents exact far beyond Number.MAX_SAFE_INTEGER', () => {
    const document = oneTransactionDocument('X', 9_007_199_254_740_993n);
    const parsed = JSON.parse(toJson(document, { pretty: false })) as {
      statements: { transactions: { amount: { cents: string } }[] }[];
    };
    expect(parsed.statements[0]?.transactions[0]?.amount.cents).toBe('9007199254740993');
  });

  it('serializes one document as an object and many as an array', () => {
    const one = JSON.parse(toJson(fixtureDocument(), { pretty: false })) as {
      version: string;
    };
    const many = JSON.parse(
      toJson([fixtureDocument(), fixtureDocument()], { pretty: false }),
    ) as unknown[];
    expect(one.version).toBe('1');
    expect(many).toHaveLength(2);
    expect(toJson([], { pretty: false })).toBe('[]');
  });

  it('pretty-prints by default and compacts when asked', () => {
    const pretty = toJson(fixtureDocument());
    const compact = toJson(fixtureDocument(), { pretty: false });
    expect(pretty).toContain('\n  "header"');
    expect(compact).not.toContain('\n');
  });
});

describe('toCsv', () => {
  it('emits the documented header and one row per transaction', () => {
    const csv = toCsv(fixtureDocument());
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    const transactions = fixtureDocument().statements.flatMap((s) => s.transactions);
    expect(lines).toHaveLength(transactions.length + 2); // header + rows + trailing CRLF
    expect(csv).toContain('-89.90');
    expect(csv).toContain('boleto');
  });

  it('escapes commas, quotes and newlines per RFC 4180', () => {
    const csv = toCsv(oneTransactionDocument('A,"B"\nC'), { bom: false });
    expect(csv).toContain('"A,""B""\nC"');
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    const fields = parseCsvRow(lines[1] ?? '');
    expect(fields).toHaveLength(CSV_COLUMNS.length);
    expect(fields[CSV_COLUMNS.indexOf('description')]).toBe('A,"B"\nC');
  });

  it('formats pt-BR amounts without losing cents and supports grouping', () => {
    const csv = toCsv(oneTransactionDocument('X', -1_234_567n), { locale: 'pt-BR' });
    expect(csv).not.toContain(';-12.345,67'); // default delimiter is still comma
    const fields = parseCsvRow(csv.split('\r\n')[1] ?? '');
    expect(fields[CSV_COLUMNS.indexOf('amount')]).toBe('-12.345,67');
    const small = toCsv(oneTransactionDocument('X', -50n), { locale: 'pt-BR' });
    expect(parseCsvRow(small.split('\r\n')[1] ?? '')[CSV_COLUMNS.indexOf('amount')]).toBe('-0,50');
  });

  it('honours a custom delimiter and UTF-8 BOM', () => {
    const csv = toCsv(oneTransactionDocument('a,b'), { delimiter: ';', bom: true });
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.slice(1).split('\r\n')[0]).toBe(CSV_COLUMNS.join(';'));
    const fields = parseCsvRow(csv.slice(1).split('\r\n')[1] ?? '', ';');
    expect(fields[CSV_COLUMNS.indexOf('description')]).toBe('a,b');
  });

  it('emits only the header for documents with no transactions', () => {
    const empty = fixtureDocument();
    for (const statement of empty.statements) {
      statement.transactions = [];
    }
    expect(toCsv(empty)).toBe(`${CSV_COLUMNS.join(',')}\r\n`);
  });

  it('rejects invalid delimiters and locales with a clear error', () => {
    for (const delimiter of ['', ';;', '"', '\r', '\n']) {
      expect(() => {
        validateDelimiter(delimiter);
      }).toThrow(RangeError);
      expect(() => toCsv([], { delimiter })).toThrow(/invalid CSV delimiter/);
    }
    expect(() => toCsv([], { locale: 'de-DE' as CsvLocale })).toThrow(/invalid CSV locale/);
    expect(() => {
      validateDelimiter('|');
    }).not.toThrow();
  });
});
