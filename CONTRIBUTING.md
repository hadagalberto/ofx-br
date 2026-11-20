# Contributing to ofx-br

Thanks for helping make Brazilian OFX exports less painful. This document is the source of truth
for local setup, conventions and review expectations. The feature contract lives in
[SPEC.md](./SPEC.md).

## Ground rules

- **No stubs, TODOs, `NotImplementedException` or placeholder tests.** Every test must assert real
  behaviour with known-valid and known-invalid vectors. Never weaken or delete a test to make a
  build pass — fix the root cause.
- **Never publish.** `git push`, `gh`, `npm publish` and any other publishing command are
  forbidden. Commit locally only, with conventional-commit messages. Stay inside this repository.
- **Keep the core browser-safe.** No Node APIs in `src/**` outside `src/node/**` and the CLI entry
  (`src/cli.ts`). ESLint enforces this with `no-restricted-imports`.
- **No invented bank facts in docs.** Describe fixtures as "modeled after commonly observed
  quirks", and never present synthetic files as real statements.

## Setup

Requires Node ≥ 20 (CI runs 20, 22 and 24) and npm.

```sh
git clone <your-fork> ofx-br
cd ofx-br
npm install
npm run build
```

## Scripts

| Command                 | What it checks                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| `npm run lint`          | ESLint with typescript-eslint strict/stylistic; `--max-warnings 0` |
| `npm run format:check`  | Prettier (run `npm run format` to fix)                             |
| `npm run typecheck`     | `tsc --noEmit`, strict TypeScript                                  |
| `npm test`              | Vitest suite, including spawned-CLI integration tests              |
| `npm run test:coverage` | Vitest + ≥90% lines, functions, statements and branches            |
| `npm run build`         | tsup: ESM + CJS + declarations + `dist/cli.js`                     |

Before opening a change, all six must pass. Warnings are errors: do not silence lint, type or build
warnings to get a green run.

## Project layout

```
src/
  encoding/     byte-level detection, decoding tables, mojibake repair
  sgml/         tolerant tokenizer + generic tree
  header.ts     OFX 1.x header / OFX 2.x processing instruction
  parse.ts      full pipeline (parse / parseBuffer)
  mapping.ts    tree → normalized model
  enrich.ts     categories, counterparties, installments, card sign
  banks.ts      embedded COMPE/ISPB table (source + date in a comment)
  money.ts      exact bigint-cent amounts and formatters
  datetime.ts   OFX dates/timezones → ISO 8601
  serialize.ts  toJson / toCsv
  node/cli.ts   CLI argument parsing and Node I/O (browser-safe core untouched)
  cli.ts        executable entry point (shebang)
test/
  fixtures/     synthetic .ofx files + .expected.json + byte-level generator
  *.test.ts     unit, property, performance and spawned-CLI tests
```

## Adding tests

- Put unit tests next to the existing suite under `test/`. Use `test/helpers.ts` byte builders
  (`utf8Bytes`, `latin1Bytes`, `cp1252Bytes`, `utf16Bytes`, …) instead of ad-hoc encodings.
- Add realistic but **synthetic** fixtures to `test/fixtures/`, regenerate them with
  `node test/fixtures/generate.mjs`, and provide a `.expected.json` plus explicit assertions in
  `test/fixtures.test.ts`. All CPF/CNPJ numbers must have valid check digits and be fake; the
  generator validates them.
- Property tests use fast-check. Lenient parsing must be total: arbitrary strings and arbitrary
  bytes must never throw.
- CLI behaviour that users see (flags, exit codes, stderr warnings) belongs in `test/cli.test.ts`
  (in-process, injectable I/O) and `test/cli-spawn.test.ts` (spawns the built artifact).

## Code style

- TypeScript strict, ESM imports with explicit `.js` extensions in relative paths (the build
  rewrites them for CJS).
- Prettier and ESLint decide formatting; do not hand-fight them.
- Public API changes must update `src/index.ts`, both READMEs, the JSDoc on the affected function
  and the changelog in the same commit.
- Warning codes are part of the API. Add a stable `code`, a human-readable message and, when
  possible, 1-based line/column to every new warning.

## Commits

Use Conventional Commits:

```
feat: add --merge to the CLI
fix: clamp invalid dates without producing NaN
test: spawn the built CLI in integration tests
docs: translate README to pt-BR
chore: regenerate fixture corpus
```

Keep commits focused; a bug fix should include its regression test.

## Reporting bugs

Attach the smallest synthetic OFX file that reproduces the issue (no real personal data), the
exact command or API call, the expected result, the observed result and warning codes. If the file
must stay private, describe the byte-level quirk and provide a hex excerpt with identifiers
redacted.
