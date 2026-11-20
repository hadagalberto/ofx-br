# ofx-br

Robust TypeScript library + CLI that parses bank and credit-card statements exported by Brazilian
banks (OFX 1.x SGML and OFX 2.x XML) and normalizes them into a clean, typed JSON model. Real
Brazilian exports are broken in many ways; this project is built to parse what banks actually emit,
never crash in the default mode, and report every repair it made.

MIT licensed · [Português](./README.pt-BR.md) · [SPEC](./SPEC.md) ·
[Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) ·
[SPEC audit](./SPEC-AUDIT.md)

## Features

- **Encoding**: OFX header `CHARSET`/`ENCODING`, BOM, XML prolog, in-house windows-1252 /
  ISO-8859-1 tables, UTF-8/16/32, and mojibake repair when a header lies.
- **Parsing**: tolerant SGML/XML tokenizer for unclosed tags, mixed case, entities and raw `&`,
  stray whitespace, NUL bytes, one-line files, truncated files and trailing garbage. Strict mode
  throws `OfxParseError` with line/column on the first problem.
- **Normalized model**: sign-on, multiple bank and credit-card statements, accounts, periods,
  balances and enriched transactions with exact `bigint` cents and ISO 8601 dates.
- **Brazilian specifics**: amount formats (`-1234,56`, `1.234,56`, `1,234.56`, `R$ …`), BRT-aware
  dates with `[−3:BRT]`-style offsets, a 65-institution COMPE/ISPB bank table, 11 Pix/TED/DOC/…
  categories, CPF/CNPJ and masked-document extraction, installments and card sign normalization.
- **Exports**: `toJson`, `toCsv` (RFC 4180) and a full CLI with `json`, `csv` and `ndjson` output.

## Install

Not published to npm. Build from source (Node ≥ 20):

```sh
npm install
npm run build
```

This produces `dist/index.js` (ESM), `dist/index.cjs` (CJS), bundled type declarations and the
`dist/cli.js` executable.

## CLI

```sh
node dist/cli.js <files...> [--format json|csv|ndjson] [--out file] [--strict] [--tz -03:00] \
  [--merge] [--dedupe] [--quiet] [--locale pt-BR] [--delimiter ';'] [--bom] [--help]
```

| Flag            | Meaning                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--format FMT`  | `json` (default): a JSON array of documents. `csv`: one row per transaction. `ndjson`: one compact JSON document per line. |
| `--out FILE`    | Write to `FILE` instead of stdout.                                                                                         |
| `--strict`      | Throw on the first problem instead of collecting warnings.                                                                 |
| `--tz OFFSET`   | Offset used for dates that carry none (default `-03:00`, e.g. `--tz +02:00`).                                              |
| `--merge`       | Combine all files into one document, grouping statements by account and deduplicating by account + FITID/hash.             |
| `--dedupe`      | Drop repeated transactions by account + FITID/hash (implied by `--merge`).                                                 |
| `--quiet`       | Do not print warnings to stderr.                                                                                           |
| `--locale LOC`  | CSV amount format: `en` → `-1234.56`; `pt-BR` → `-1.234,56`.                                                               |
| `--delimiter C` | CSV field separator (default `,`); use `--delimiter ';'` for pt-BR spreadsheets.                                           |
| `--bom`         | Prefix output with a UTF-8 BOM (Excel-friendly).                                                                           |
| `--help`        | Print usage and exit.                                                                                                      |

Flags may appear before or after file names; `--` ends option parsing. All value flags also accept
`--flag=value`.

Examples:

```sh
# Human-readable parse of one statement (warnings on stderr)
node dist/cli.js extrato.ofx --format json

# One CSV per account, ready for a pt-BR Excel spreadsheet
node dist/cli.js extrato.ofx --format csv --locale pt-BR --delimiter ';' --bom --out extrato.csv

# Fail on any malformed input; apply a custom default timezone
node dist/cli.js a.ofx b.ofx --strict --tz +02:00

# Combine monthly exports without paying the same FITID twice
node dist/cli.js jan.ofx fev.ofx --merge --out consolidate.json
```

**Exit codes:** `0` success, `1` parse/file error (including any error in `--strict` mode), `2`
usage error. Warnings are printed to stderr with a stable code and, when available, line/column;
`--quiet` suppresses them.

**Output details**

- JSON writes `Money.cents` as an exact **decimal string** (JSON has no bigint literal).
- CSV is RFC 4180: quoted fields where needed, doubled quotes, CRLF line endings. Columns (in
  order): `kind,currency,bankId,bankName,branchId,accountId,accountType,periodStart,periodEnd,id,fitid,type,direction,amount,postedAt,userDate,description,name,memo,checkNumber,refNumber,category,counterpartyName,counterpartyDocument,installmentCurrent,installmentTotal`
  (also exported as `CSV_COLUMNS`).
- `--merge` keeps both duplicate FITIDs from a single statement as distinct rows; dropping only
  the same account + FITID/hash across files. Every drop emits a `duplicate-transaction-dropped`
  warning.
- `tsup` preserves the executable shebang, so `./dist/cli.js` works after `npm run build` on
  POSIX; `npm exec ofx-br -- …` works after linking the package locally.

## Library API

```ts
import {
  detectEncoding,
  decodeOfx,
  parseOfxHeader,
  parseSgml,
  parse,
  parseBuffer,
  toJson,
  toCsv,
  CSV_COLUMNS,
} from 'ofx-br';
```

### Parsing pipeline

```ts
detectEncoding(bytes: Uint8Array): EncodingDetection
// { encoding: 'windows-1252', source: 'ofx-header', bom: false,
//   declaredLabel: '1252', declaredEncoding: 'windows-1252' }

decodeOfx(bytes: Uint8Array): DecodeResult
// { text, encoding, detection, warnings: [{ code: 'mojibake-repaired', ... }] }

parseOfxHeader(text: string, opts?: { strict?: boolean }): OfxHeaderResult
// { header: { OFXHEADER: '100', CHARSET: '1252', ... }, version: '1',
//   xmlProlog?, endOffset, warnings }

parseSgml(text: string, opts?: {
  startOffset?: number;
  flavor?: 'sgml' | 'xml';
  strict?: boolean;
}): SgmlParseResult

parse(text: string, opts?: {
  strict?: boolean; tz?: string; encoding?: string; verifyBalance?: boolean;
}): OfxDocument

parseBuffer(bytes: Uint8Array, opts?: {
  strict?: boolean; tz?: string; verifyBalance?: boolean;
}): OfxDocument
```

`parseBuffer` is the usual entry point: it detects and decodes bytes (including mojibake repair),
then runs header, tree and mapping. The result is an `OfxDocument`:

```ts
{
  header: { OFXHEADER: '100', /* ... */ },
  version: '1' | '2' | 'unknown',
  encoding: 'windows-1252',
  signOn: { statusCode: 0, severity: 'INFO', serverDate: '2024-01-15T12:00:00-03:00',
            org: 'ITAU UNIBANCO', fid: '341' },
  statements: [{
    kind: 'bank' | 'creditcard', currency: 'BRL',
    account: { bankId: '341', bankName: 'ITAÚ UNIBANCO S.A.', branchId: '1234',
               accountId: '999999999999', accountType: 'CHECKING' },
    period: { start: '2024-01-01', end: '2024-01-31' },
    ledgerBalance: { amount: { cents: 123456n, currency: 'BRL' }, date: '2024-01-31' },
    availableBalance: { amount: { cents: 120056n, currency: 'BRL' }, date: '2024-01-31' },
    transactions: [{
      id: '2024010500001', fitid: '2024010500001', type: 'DEBIT', direction: 'debit',
      amount: { cents: -8990n, currency: 'BRL' },
      postedAt: '2024-01-05T08:30:00-03:00', userDate: undefined,
      description: 'PAGAMENTO BOLETO COMPANHIA ENERGÉTICA',
      name: 'PAGAMENTO BOLETO', memo: 'COMPANHIA ENERGÉTICA',
      category: 'boleto', counterparty: { name: 'COMPANHIA ENERGÉTICA' },
    }],
  }],
  warnings: [{ code: 'unclosed-aggregate', message: '…', line: 12, column: 3 }],
}
```

Notes:

- Default mode is lenient: nothing throws on malformed input; every repair is a warning with a
  stable code and 1-based line/column. With `strict: true` the first problem throws
  `OfxParseError` carrying `code`, `line` and `column`.
- `tz` applies to datetimes without an explicit `[offset]` suffix; default `-03:00` (BRT).
- Duplicate FITIDs within one statement keep both rows as `fitid`, `fitid#2`, … (warned); a missing
  FITID gets a deterministic `hash-<16 hex>` id.
- `verifyBalance: true` compares each statement's transaction sum with `LEDGERBAL` and reports a
  `balance-mismatch` warning. Enable it only for exports that list every movement since the
  account opening.

### Export helpers

```ts
toJson(document | documents, opts?: { pretty?: boolean }): string
// bigint cents → exact decimal strings; pretty (2 spaces) by default

toCsv(document | documents, opts?: {
  delimiter?: string;   // default ','
  locale?: 'en' | 'pt-BR';
  bom?: boolean;
}): string
// RFC 4180, CRLF, one row per transaction
```

### Helpers exported piecewise

```ts
detectMemoCategory(memo): PixCategory | undefined          // pix, ted, doc, boleto, tarifa, iof,
                                                            // juros, estorno, saque, card-purchase, transfer
extractCounterparty(memo, opts?): Counterparty | undefined // names, CPF/CNPJ, masked forms
detectInstallment(memo): { current, total } | undefined     // 'PARC 02/10'
enrichMemo(description, opts?): MemoEnrichment
enrichTransaction(transaction, kind): void

parseAmountToCents(raw): bigint | undefined   // exact cents, every BR convention
formatOfxAmount(money): string                // '-1234.56'
formatMoney(money): string                    // '-R$ 1.234,56'
moneyToNumber(money): number                  // display only
parseOfxDateTime(raw, defaultOffsetMinutes?): OfxDateTimeResult

BRAZILIAN_BANKS: readonly BrazilianBank[]     // 65 institutions, COMPE + ISPB + names
resolveBank(id), resolveBankByCompe(code), resolveBankByIspb(ispb), normalizeBankId(id)
```

Encoding detection order: BOM → UTF-16-without-BOM pattern → OFX header `ENCODING`/`CHARSET` →
XML prolog → heuristic (valid UTF-8 → UTF-8, otherwise windows-1252). Tree building follows OFX
semantics rather than XML theory: leaf end tags are optional in the 1.x DTD, aggregates close
implicitly with a warning, and repeated unclosed `<STMTTRN>` elements become siblings.

## Tests and fixtures

The corpus in `test/fixtures/` contains 38 synthetic OFX files (fake names; CPF/CNPJ check digits
generated and validated by `generate.mjs`) modeled after commonly observed quirks of Brazilian
exports. Each has a complete `.expected.json` plus explicit known-valid/known-invalid assertions in
`test/fixtures.test.ts`; see `test/fixtures/README.md` for the index. CLI tests spawn the built
`dist/cli.js` as a real process. fast-check property tests cover amount parsing and the "never
throws in lenient mode" guarantee; performance guards parse 100k transactions in under 2 seconds.

```sh
npm run lint          # ESLint (typescript-eslint strict), warnings as errors
npm run format:check  # Prettier
npm run typecheck     # tsc --noEmit, strict
npm test              # Vitest
npm run test:coverage # Vitest + ≥90% lines/functions/statements/branches
npm run build         # tsup: ESM + CJS + declarations + CLI
```

CI runs lint, format check, typecheck, tests with coverage and the build on Node 20/22/24 on both
Ubuntu and Windows.

## License

[MIT](./LICENSE) © Hadagalberto Junior
