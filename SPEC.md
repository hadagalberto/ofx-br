# ofx-br — SPEC

Robust TypeScript library + CLI to parse bank/credit-card statements exported by Brazilian banks (OFX 1.x SGML, OFX 2.x XML)
and normalize them into a clean, typed JSON model. Open source (MIT, "Hadagalberto Junior").

Real-world Brazilian OFX files are broken in many ways. That is the whole point of this project: parse what real banks emit,
never crash, and report what was fixed. This is NOT a toy: no stubs, no `TODO`, no skipped or placeholder tests, no "simplified" parsing.

## Stack

- TypeScript 5 strict, ESM + CJS dual build (tsup), Node ≥ 20, also works in browsers (no Node APIs in the core; Node-only I/O lives in `src/node/` and the CLI).
- Zero runtime deps in core. Tests with Vitest (+ coverage ≥ 90% lines on core). Lint with ESLint (typescript-eslint, strict) and Prettier.
- Package name `ofx-br`. Exports: `parse`, `parseBuffer`, `detectEncoding`, `toCsv`, `toJson`, types. CLI bin `ofx-br`.
- GitHub Actions CI: lint, typecheck, test with coverage, build, on Node 20/22/24, ubuntu + windows.
- Docs: README.md (English) + README.pt-BR.md, CHANGELOG.md, CONTRIBUTING.md, LICENSE. DO NOT publish to npm.

## Parsing pipeline

1. **Bytes → text**: `detectEncoding(Uint8Array)`: honour OFX header `CHARSET`/`ENCODING` (1252, ISO-8859-1, USASCII, UTF-8),
   BOM, XML prolog encoding; fall back to heuristics (valid UTF-8 → UTF-8, else windows-1252). Implement the windows-1252 / latin1 decode table
   in-house (TextDecoder may lack it in some runtimes; use it when available). Detect and repair mojibake (`Ã§` → `ç`) when the
   header lies — record a warning.
2. **Header**: parse OFX 1.x key:value header and OFX 2.x `<?OFX ...?>` processing instruction. Missing/garbage header tolerated.
3. **Tokenizer/parser** for SGML: unclosed leaf elements (`<TRNAMT>-10.00` without `</TRNAMT>`), aggregates closed or not,
   mismatched case, stray whitespace/newlines inside values, `&amp;`/`&lt;` entities and raw `&`, tags on one huge line,
   CRLF/LF/CR, trailing garbage, duplicated closing tags, NUL bytes. Build a generic tree, then map to the model.
   Never throw on malformed input in lenient mode (default); collect `warnings: ParseWarning[]` with code + location.
   `strict: true` option throws `OfxParseError` with line/column on the first problem.
4. **Mapping** to the model below for: `BANKMSGSRSV1/STMTTRNRS` (checking/savings), `CREDITCARDMSGSRSV1/CCSTMTTRNRS` (credit card),
   multiple statements per file, `SIGNONMSGSRSV1` (status, server date, FI org/FID).

## Normalized model

```ts
interface OfxDocument {
  header: Record<string, string>; version: '1' | '2' | 'unknown';
  signOn?: { statusCode: number; severity: string; serverDate?: string /* ISO */; org?: string; fid?: string; };
  statements: Statement[]; warnings: ParseWarning[]; encoding: string;
}
interface Statement {
  kind: 'bank' | 'creditcard'; currency: string /* ISO 4217 */;
  account: { bankId?: string; bankName?: string /* resolved from COMPE/ISPB table */; branchId?: string; accountId: string; accountType?: string; };
  period: { start?: string; end?: string }; // ISO 8601 with offset
  ledgerBalance?: { amount: Money; date?: string }; availableBalance?: { amount: Money; date?: string };
  transactions: Transaction[];
}
interface Transaction {
  id: string /* FITID, or deterministic hash when missing/duplicated */; fitid?: string;
  type: string /* TRNTYPE raw */; direction: 'credit' | 'debit';
  amount: Money; postedAt: string; userDate?: string;
  description: string /* MEMO/NAME merged & cleaned */; name?: string; memo?: string;
  checkNumber?: string; refNumber?: string;
  category?: PixCategory; counterparty?: { name?: string; document?: string /* CPF/CNPJ if detectable */ };
}
type Money = { cents: bigint; currency: string; }  // never floats; also expose helper toNumber/format pt-BR
```

## Brazilian specifics (required)

- **Amounts**: accept `-1234.56`, `-1234,56`, `1.234,56`, `1,234.56`, `+10`, spaces, `R$`; parse to integer cents (bigint) exactly. Ambiguity resolved by last separator + digit count; tested heavily.
- **Dates**: `YYYYMMDD`, `YYYYMMDDHHMMSS`, `YYYYMMDDHHMMSS.XXX`, with timezone `[-3:BRT]`, `[-03:EST]`, `[0:GMT]`, `[-3]`, missing tz (default `-03:00`, configurable).
  Invalid dates (e.g. `20240230`) → warning + best-effort or `undefined`, never NaN.
- **Bank name resolution** from BANKID (COMPE code, 3 digits, zero-padded) using an embedded table of Brazilian banks (code, ISPB, short name) — include at least the 60 most common institutions (001 BB, 033 Santander, 077 Inter, 104 Caixa, 237 Bradesco, 260 Nu Pagamentos, 290 PagSeguro, 323 Mercado Pago, 336 C6, 341 Itaú, 380 PicPay, 748 Sicredi, 756 Sicoob, 208 BTG, 212 Original, 655 Votorantim, 422 Safra, 070 BRB, 041 Banrisul, 004 BNB, 021 Banestes, 403 Cora, 197 Stone, 102 XP, ...). Mark the table source and date in a comment.
- **Transaction enrichment**: detect Pix/TED/DOC/boleto/tarifa/IOF/juros/estorno/saque/compra cartão/transferência in MEMO/NAME (pt-BR, case/accents-insensitive) → `category`.
  Extract counterparty name and CPF/CNPJ (masked `***.123.456-**` also recognised) from common memo patterns ("Pix enviado - FULANO", "TRANSF ... CPF ...").
- **Credit card**: amounts sign convention normalized (purchases = debit), installments "PARC 02/10" detected → `installment: { current, total }`.
- **Dedup**: duplicate FITIDs within a statement (some banks reuse) → keep both, make ids unique deterministically (`fitid#2`), warn.
- **Balance check**: optional `verifyBalance` computes running sum vs LEDGERBAL and reports mismatch as a warning.

## CLI (`ofx-br`)

`ofx-br <files...> [--format json|csv|ndjson] [--out file] [--strict] [--tz -03:00] [--merge] [--dedupe] [--quiet]`
- CSV: RFC 4180, `;` delimiter option and pt-BR number format option (`--locale pt-BR`), UTF-8 BOM option for Excel.
- `--merge` combines multiple files and dedupes overlapping periods by (account, fitid|hash).
- Exit codes: 0 ok, 1 parse errors (strict), 2 usage. Warnings to stderr unless `--quiet`.

## Test corpus (required)

Create `test/fixtures/` with ≥ 25 synthetic but realistic OFX files reproducing real-world quirks of Brazilian exports
(Itaú-style SGML with no closing tags and 1252 charset; Bradesco with `[-3:BRT]`; Nubank card OFX; Inter with XML 2.x;
Caixa with comma decimals; BB with mojibake; files with multiple statements; truncated file; duplicated FITIDs; empty BANKTRANLIST; huge single-line file; etc).
NEVER include real personal data — names/CPFs must be fake (generate valid-but-fake CPFs). Each fixture has a snapshot / explicit expected-output test.
Also property-based tests (fast-check) for amount parsing and for "parser never throws in lenient mode on arbitrary input".
Performance test: 100k transactions parsed in < 2 s on CI (assert generous bound).

## Hard constraints

- Never run `git push`, `gh`, `npm publish`, or anything that publishes. Commit locally after each milestone (conventional commits).
- Stay inside this repository directory.
- Do not invent bank behaviours as facts in docs; describe fixtures as "modeled after commonly observed quirks".
