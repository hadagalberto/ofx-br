# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- `ofx-br` CLI entry point (encoding + header inspection).
