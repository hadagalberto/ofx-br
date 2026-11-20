# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
