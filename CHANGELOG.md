# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Full `ofx-br` CLI per SPEC.md: `--format json|csv|ndjson`, `--out`, `--strict`, `--tz`,
  `--merge`, `--dedupe`, `--quiet`, `--locale pt-BR`, `--delimiter`, `--bom` and `--help`.
  It parses complete documents (not just headers), writes warnings to stderr with stable codes
  and locations, honours exit codes 0/1/2, and deduplicates by account + FITID/hash on `--merge`
  and `--dedupe`. Read/write happens in `src/node/` so the core stays runtime-agnostic.
- Public export helpers `toJson` and `toCsv` (plus `CSV_COLUMNS`, `UTF8_BOM`,
  `validateDelimiter` and their types): JSON writes bigint cents as exact decimal strings; CSV is
  RFC 4180 with configurable delimiter, `en`/`pt-BR` amounts and optional UTF-8 BOM.
- Documentation: complete English `README.md`, full Brazilian Portuguese `README.pt-BR.md`,
  `CONTRIBUTING.md`, and updated changelog. CLI tests now spawn the built `dist/cli.js` as a real
  process, alongside unit tests for every flag and serializer.
- Memo enrichment (SPEC.md "Transaction enrichment" + "Credit card"), run
  automatically by `parse`/`parseBuffer` and exported piecewise
  (`detectMemoCategory`, `extractCounterparty`, `detectInstallment`,
  `enrichMemo`, `enrichTransaction`):
  - **Categories** for pix, TED, DOC, boleto, tarifa, IOF, juros, estorno,
    saque, salário, rendimento, investimento, card purchase and generic transfer,
    matched pt-BR case- and
    accent-insensitively on an index-preserving folded copy of the memo;
    word-boundary rules keep `DOCX`/`COMPRACARTAO` out, and a documented
    priority (fees before their operation, refunds before everything)
    settles multi-keyword memos like "ESTORNO PIX" or "TARIFA DE TED".
  - **Counterparties**: names extracted after operation keywords
    ("Pix enviado - FULANO", "TED BANCO X", "compra cartão MERCADO") with
    original accents preserved and bank-label noise peeled; CPF/CNPJ in full
    (`123.456.789-09`), masked (`***.123.456-**`) and bare-keyword
    (`CPF 12345678909`) forms; fee/interest/withdrawal memos carry no
    counterparty; for card statements whose memo is only the bank label
    ("Compra cartão"), the merchant comes from `NAME`.
  - **Installments**: `PARC 02/10`-style plans (`parcela`, `parcelada`,
    `parcelamento`, squashed `parc02/10`) → `installment: { current, total }`
    with sane bounds — the keyword requirement keeps date fragments out.
  - **Credit-card sign normalization**: purchases are debits — a positive
    purchase (some Brazilian card exporters emit them positive) flips
    negative, a negative refund flips positive, a detected purchase/refund
    outranks a mislabelled `TRNTYPE`, ambiguous rows are untouched and bank
    statements keep amounts exactly as emitted.
- Optional `verifyBalance` option on `parse`/`parseBuffer`: computes the
  statement's transaction running sum (after card sign normalization) and
  reports a `LEDGERBAL` mismatch as a `balance-mismatch` warning with both
  amounts and the difference, located at the `<LEDGERBAL>` element (thrown
  in strict mode). Off by default; meaningful for exports that list every
  movement since the account opening.
- `parse`/`parseBuffer`: the full pipeline — decode → header → tree →
  normalized model. `OfxDocument` carries the header, version, encoding,
  sign-on (`SONRS`: status, severity, server date, FI org/FID), every bank
  (`STMTTRNRS/STMTRS`) and credit-card (`CCSTMTTRNRS/CCSTMTRS`) statement in
  document order, with accounts, periods, ledger/available balances and
  transactions. Same leniency contract as the previous stages: nothing
  throws in lenient mode, `strict: true` throws `OfxParseError` with code
  and line/column, and warnings are capped at 1000 with a truncation notice.
- Amount parsing to **exact bigint cents** for every convention in the SPEC:
  `-1234.56`, `-1234,56`, `1.234,56`, `1,234.56`, `+10`, grouped thousands
  (`2.500`, `1.234.567`), `R$` prefixes (before or after the sign), stray and
  NBSP whitespace, leading-separator decimals, and >2-decimal fractions
  rounded half away from zero — ambiguity resolved per the SPEC by the last
  separator and digit count. Helpers: `formatMoney` (pt-BR, `-R$ 1.234,56`),
  `formatOfxAmount` (canonical `-1234.56`), `moneyToNumber`. Property tests
  round-trip cents through both formatters and an independent formatter, and
  prove exactness far beyond `Number.MAX_SAFE_INTEGER`.
- OFX date/timezone parsing per the SPEC: `YYYYMMDD`, `YYYYMMDDHHMMSS`,
  `YYYYMMDDHHMM(.SS)`, `.XXX` fractions, `[-3:BRT]`/`[-03:EST]`/`[0:GMT]`/
  `[-3]`/`[+05:30]` offsets, a `-03:00` default configurable via the `tz`
  option (invalid values warn and fall back), ISO 8601 output with offset,
  best-effort clamps for invalid dates (`20240230` → `2024-02-29`, warned)
  and no-ISO-for-garbage (`invalid-date`), never NaN. Property tests round
  trip valid dates exactly and never throw on arbitrary input.
- Embedded Brazilian bank table: 65 institutions with COMPE code, ISPB,
  official and short names (source: Banco Central do Brasil STR/COMPE
  participants list, marked in `src/banks.ts` with retrieval date).
  `resolveBank`/`resolveBankByCompe`/`resolveBankByIspb` resolve `BANKID`
  values (1–3 digits zero-padded as COMPE, 8 digits as ISPB);
  `normalizeBankId` pads numeric ids; `account.bankName` is filled from the
  table.
- Transaction mapping details per the SPEC model: `direction` from `TRNTYPE`
  with sign fallback, `description` as NAME/MEMO merged and whitespace
  cleaned (NBSP collapsed, duplicates dropped), `postedAt`/`userDate`,
  `checkNumber`/`refNumber`, unique deterministic ids — raw `FITID`,
  `fitid#2`/`#3` suffixes for duplicates (warned), `hash-<16 hex>` (FNV-1a)
  when missing — and statement-level repairs (missing `CURDEF` → `XXX`,
  missing account ids, nonzero TRN status, responses without a statement
  aggregate, unparsable balances/amounts skipped) all reported with stable
  warning codes and 1-based line/column.
- Performance guard: 100k transactions through the full `parse` pipeline in
  well under 2 s (relaxed bound under coverage instrumentation, which
  measures the profiler; CI now runs the plain suite too, where the strict
  bound applies).
- `parseSgml`: lenient SGML/XML tokenizer and tree builder for the OFX body.
  Handles every quirk real Brazilian exports show — unclosed leaf elements
  (legal per the OFX 1.x DTD, silent in `sgml` flavor, warned in `xml`
  flavor), unclosed aggregates (closed implicitly, warned), repeated
  unclosed same-name aggregates read as siblings (repeated `<STMTTRN>`),
  case-insensitive tag matching, `&amp;`/`&lt;`/numeric entities plus raw `&`
  kept as text, single-line files, mixed CRLF/LF/CR, NUL bytes (stripped,
  reported once), duplicated and stray closing tags, trailing garbage,
  comments/PIs/declarations in the body, XML-style attributes and
  self-closing tags. Strict mode throws `OfxParseError` (code + line/column)
  on the first problem.
- Property-based tests (fast-check): lenient parsing is total — arbitrary
  strings, arbitrary 16-bit code-unit sequences and arbitrary bytes never
  throw; random well-formed documents round-trip exactly with zero warnings.
- Performance guard: 100k transactions parse in well under 2 s.
- Fixture corpus: 38 synthetic OFX files in `test/fixtures/` (fake data only;
  CPF/CNPJ check digits generated and validated by `generate.mjs`), each with
  a complete `.expected.json` document and explicit known-valid/known-invalid
  vector assertions covering every quirk in SPEC.md. `test/fixtures/README.md`
  maps each file to the quirk it models.

### Fixed

- Counterparty extraction no longer mistakes `PARC 02/10`/`PARC12/48`
  installment fragments, numeric fragments (`NUMERO 12345 …`) or the
  `PAGAMENTO FATURA` bill-payment label for a person or merchant.
- Credit-card direction now follows the detected intent even when the amount
  already has the right sign: a refund mislabelled `TRNTYPE>DEBIT` is a
  `credit`, not a debit.
- `CREDITO SALARIO` (and other salary/yield/investment memos) now get a
  category; payout labels are fallbacks behind explicit operations, so a
  `TED … CONTA SALARIO` stays `ted`.
- Spawned-CLI tests no longer derive an npm entry point from `process.execPath`
  (broken on hosted Node 20 toolcache images): a Vitest `globalSetup` builds
  the artifact once through the tsup API and the tests only spawn
  `node dist/cli.js`.
- Encoding table tests assert hard-coded WHATWG/Unicode code points instead of
  trusting the runtime `TextDecoder`; the `TextDecoder` cross-checks are
  feature-detected and skipped with a logged reason when the runtime decoder
  is unavailable or non-conformant.
- Windows checkouts no longer break `prettier --check`: `.gitattributes` keeps
  all text files LF (`* text=auto eol=lf`) while byte-exact `.ofx` fixtures stay
  untouched (`*.ofx -text`).

## [0.1.0] - 2026-11-20

### Added

- Project scaffold: strict TypeScript, dual ESM/CJS build (tsup), Vitest with
  coverage thresholds (≥ 90% on core), ESLint (typescript-eslint strict) +
  Prettier, MIT license, GitHub Actions CI matrix (Node 20/22/24 on
  ubuntu + windows).
- `detectEncoding`: BOM (UTF-8/16/32), OFX 1.x header `ENCODING`/`CHARSET`,
  XML prolog `encoding`, UTF-16-without-BOM pattern detection, and a
  UTF-8-validity heuristic fallback.
- Decoding with in-house `windows-1252` and ISO-8859-1 tables plus UTF-8,
  UTF-16 and UTF-32 decoders (no runtime dependency on `TextDecoder`
  support); mojibake repair (`Ã§` → `ç`) when the header lies, reported as
  parse warnings.
- `parseOfxHeader`: tolerant OFX 1.x key:value header and OFX 2.x
  `<?OFX ...?>` processing-instruction parsing, including XML prolog
  capture, version detection, and byte/line-accurate warnings.
- `ofx-br` CLI entry point (initially encoding + header inspection; the full statement CLI landed
  in the Unreleased work above).
