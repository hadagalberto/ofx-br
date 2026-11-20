/**
 * Export helpers: `toJson` and `toCsv` (SPEC "Stack" — both are part of the
 * public API and back the CLI's `--format json|csv|ndjson`).
 *
 * `Money.cents` is a `bigint` in the normalized model. JSON has no bigint
 * literal, so serializers emit cents as an exact **decimal string** — never a
 * lossy `number`. CSV emits one row per transaction, in document/statement
 * order, with RFC 4180 quoting and CRLF line endings.
 */
import type { OfxDocument, Statement, Transaction } from './model.js';
import { formatOfxAmount } from './money.js';

/** UTF-8 BOM, prepended to output when requested (`--bom`). */
export const UTF8_BOM = '\uFEFF';

/** Number formatting used by `toCsv`. `en` = canonical OFX `-1234.56`; `pt-BR` = `-1.234,56`. */
export type CsvLocale = 'en' | 'pt-BR';

/** Options for {@linkcode toJson}. Pretty output (2 spaces) is the default. */
export interface ToJsonOptions {
  /** `false` emits a single compact line; default `true`. */
  pretty?: boolean;
}

/** Options for {@linkcode toCsv}. */
export interface ToCsvOptions {
  /** Single-character field separator, default `,`. */
  delimiter?: string;
  /** Amount formatting, default `'en'`. */
  locale?: CsvLocale;
  /** Prepend a UTF-8 BOM (Excel friendliness), default `false`. */
  bom?: boolean;
}

/** Ordered CSV header. Stable — downstream consumers may rely on it. */
export const CSV_COLUMNS = [
  'kind',
  'currency',
  'bankId',
  'bankName',
  'branchId',
  'accountId',
  'accountType',
  'periodStart',
  'periodEnd',
  'id',
  'fitid',
  'type',
  'direction',
  'amount',
  'postedAt',
  'userDate',
  'description',
  'name',
  'memo',
  'checkNumber',
  'refNumber',
  'category',
  'counterpartyName',
  'counterpartyDocument',
  'installmentCurrent',
  'installmentTotal',
] as const;

/** Normalizes the single-document / many-documents input accepted by both serializers. */
function asDocuments(input: OfxDocument | readonly OfxDocument[]): readonly OfxDocument[] {
  return Array.isArray(input) ? (input as readonly OfxDocument[]) : [input as OfxDocument];
}

/** JSON replacer: exact bigint cents become decimal strings. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Serializes one or more normalized documents to JSON. Bigint cents are
 * written as exact decimal strings. No trailing newline is added.
 */
export function toJson(
  input: OfxDocument | readonly OfxDocument[],
  options: ToJsonOptions = {},
): string {
  const documents = asDocuments(input);
  let value: unknown;
  if (Array.isArray(input)) {
    value = documents;
  } else {
    value = documents[0] ?? input;
  }
  return JSON.stringify(value, jsonReplacer, options.pretty === false ? undefined : 2);
}

/** pt-BR number format with grouping and a comma decimal: `-1.234,56`. */
function formatPtBrNumber(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const units = (magnitude / 100n).toString();
  let grouped = '';
  for (let i = 0; i < units.length; i++) {
    if (i > 0 && (units.length - i) % 3 === 0) {
      grouped += '.';
    }
    grouped += units.charAt(i);
  }
  const body = `${grouped},${(magnitude % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/** Validates a CSV delimiter: exactly one code point, not a quote or newline. */
export function validateDelimiter(delimiter: string): void {
  if (
    Array.from(delimiter).length !== 1 ||
    delimiter === '"' ||
    delimiter === '\r' ||
    delimiter === '\n'
  ) {
    throw new RangeError(
      `invalid CSV delimiter ${JSON.stringify(delimiter)}: expected one character other than '"', CR or LF`,
    );
  }
}

/** RFC 4180 field quoting: quote when the value holds the delimiter, a quote or a newline. */
function csvField(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** One transaction row, with `undefined` model fields rendered as empty cells. */
function transactionRow(
  statement: Statement,
  transaction: Transaction,
  locale: CsvLocale,
  delimiter: string,
): string {
  const amount =
    locale === 'pt-BR'
      ? formatPtBrNumber(transaction.amount.cents)
      : formatOfxAmount(transaction.amount);
  const fields: string[] = [
    statement.kind,
    statement.currency,
    statement.account.bankId ?? '',
    statement.account.bankName ?? '',
    statement.account.branchId ?? '',
    statement.account.accountId,
    statement.account.accountType ?? '',
    statement.period.start ?? '',
    statement.period.end ?? '',
    transaction.id,
    transaction.fitid ?? '',
    transaction.type,
    transaction.direction,
    amount,
    transaction.postedAt,
    transaction.userDate ?? '',
    transaction.description,
    transaction.name ?? '',
    transaction.memo ?? '',
    transaction.checkNumber ?? '',
    transaction.refNumber ?? '',
    transaction.category ?? '',
    transaction.counterparty?.name ?? '',
    transaction.counterparty?.document ?? '',
    transaction.installment?.current.toString() ?? '',
    transaction.installment?.total.toString() ?? '',
  ];
  return fields.map((field) => csvField(field, delimiter)).join(delimiter);
}

/**
 * Serializes one or more normalized documents to RFC 4180 CSV: one header
 * row plus one row per transaction, CRLF separated. Optional UTF-8 BOM.
 */
export function toCsv(
  input: OfxDocument | readonly OfxDocument[],
  options: ToCsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  validateDelimiter(delimiter);
  const locale: string = options.locale ?? 'en';
  if (locale !== 'en' && locale !== 'pt-BR') {
    throw new RangeError(`invalid CSV locale ${JSON.stringify(locale)}: expected 'en' or 'pt-BR'`);
  }
  const rows = [CSV_COLUMNS.join(delimiter)];
  for (const document of asDocuments(input)) {
    for (const statement of document.statements) {
      for (const transaction of statement.transactions) {
        rows.push(transactionRow(statement, transaction, locale, delimiter));
      }
    }
  }
  const body = `${rows.join('\r\n')}\r\n`;
  return options.bom === true ? `${UTF8_BOM}${body}` : body;
}
