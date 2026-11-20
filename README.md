# ofx-br

Robust TypeScript library + CLI to parse bank and credit-card statements exported by
Brazilian banks (OFX 1.x SGML, OFX 2.x XML) and normalize them into a clean, typed
JSON model. Built for the broken files real banks export — never crash, always
report what was fixed. MIT licensed. See [`SPEC.md`](./SPEC.md) for the full plan.

> **Status (v0.1.0):** encoding detection & decoding, mojibake repair, OFX
> 1.x/2.x header parsing, the lenient SGML/XML body tokenizer + tree builder
> and the full mapping to the normalized model are implemented and fully
> tested — `parse`/`parseBuffer` deliver sign-on, bank and credit-card
> statements (several per file), balances and transactions, with exact
> bigint-cent amounts, ISO 8601 dates (BRT default, `tz` option), bank-name
> resolution from an embedded 65-institution COMPE/ISPB table and
> deterministic ids for duplicated/missing FITIDs. Memo enrichment
> (Pix/TED/DOC categories, counterparties, installments), CSV export and the
> full CLI surface are upcoming milestones.

## Install

Not published to npm yet; build from source (Node ≥ 20):

```sh
npm install
npm run build
```

## CLI

```sh
node dist/cli.js statement.ofx [--quiet]
```

Prints a JSON report per file — detected encoding, OFX header, version and any
warnings — and exits 0 (ok), 1 (file errors) or 2 (usage errors). Warnings go
to stderr unless `--quiet`.

## API

```ts
import { detectEncoding, decodeOfx, parseOfxHeader, parseSgml } from 'ofx-br';

// 1. What encoding is this file in, and what did it declare?
detectEncoding(bytes: Uint8Array): EncodingDetection
// { encoding: 'windows-1252', source: 'ofx-header', bom: false,
//   declaredLabel: '1252', declaredEncoding: 'windows-1252' }

// 2. Bytes → text, repairing what real banks get wrong (mojibake, lying
//    headers, truncated UTF-16), each repair reported as a warning.
decodeOfx(bytes: Uint8Array): DecodeResult
// { text, encoding, detection, warnings: [{ code: 'mojibake-repaired', ... }] }

// 3. OFX header: 1.x key:value block or 2.x `<?OFX ...?>` + XML prolog.
parseOfxHeader(text: string, opts?: { strict?: boolean }): OfxHeaderResult
// { header: { OFXHEADER: '100', CHARSET: '1252', ... }, version: '1',
//   xmlProlog?, endOffset, warnings }

// 4. Body → element tree, leniently: unclosed leaves/aggregates, mismatched
//    case, raw '&' and entities, one-line files, mixed newlines, NUL bytes,
//    duplicated closing tags, trailing garbage. `startOffset` keeps warning
//    positions file-global when the header is still in `text`.
parseSgml(text: string, opts?: {
  startOffset?: number;
  flavor?: 'sgml' | 'xml'; // 'xml' warns on unclosed leaves
  strict?: boolean;        // throw OfxParseError on the first problem
}): SgmlParseResult
// { root: { name: '#document', children: [ { name: 'OFX', children: [...] } ] },
//   warnings: [{ code: 'unclosed-aggregate', line: 12, column: 3, ... }] }

// 5. The whole pipeline → the normalized model: sign-on, statements, balances,
//    transactions. Same leniency contract, same warning codes + locations.
parse(text: string, opts?: { strict?: boolean; tz?: string; encoding?: string }): OfxDocument
parseBuffer(bytes: Uint8Array, opts?: { strict?: boolean; tz?: string }): OfxDocument
// { header: { OFXHEADER: '100', ... }, version: '1', encoding: 'utf-8',
//   signOn: { statusCode: 0, severity: 'INFO', serverDate: '2024-01-15T12:00:00-03:00',
//             org: 'ITAU UNIBANCO HOLDING', fid: '0010' },
//   statements: [{
//     kind: 'bank', currency: 'BRL',
//     account: { bankId: '341', bankName: 'ITAÚ UNIBANCO S.A.', branchId: '1234',
//                accountId: '999999999999', accountType: 'CHECKING' },
//     period: { start: '2024-01-01', end: '2024-01-31' },
//     ledgerBalance: { amount: { cents: 123456n, currency: 'BRL' }, date: '2024-01-31' },
//     transactions: [{
//       id: '20240105001', fitid: '20240105001', type: 'DEBIT', direction: 'debit',
//       amount: { cents: -8990n, currency: 'BRL' },
//       postedAt: '2024-01-05T12:00:00-03:00',
//       description: 'PAGAMENTO BOLETO COMPANHIA ENERGETICA', ...
//     }] }],
//   warnings: [...] }
//
// - `tz` applies to date/time values without an `[offset]` suffix
//   (default `'-03:00'`, BRT — Brazil has had no DST since 2019).
// - duplicate FITIDs inside one statement keep both rows with ids
//   `fitid`, `fitid#2`, … (warned); a missing FITID gets a deterministic
//   `hash-<16 hex>` id.
// - unparsable amounts skip the transaction with an `invalid-amount`
//   warning; invalid dates clamp best-effort (`20240230` → `2024-02-29`)
//   and are never NaN.

// 6. Amounts, dates and the bank table, exported individually.
parseAmountToCents(raw: string): bigint | undefined
// '-1234.56', '-1234,56', '1.234,56', '1,234.56', '+10', '2.500' (group),
// 'R$ 1.234,56' → exact cents; ambiguity per SPEC: last separator + digit count.
formatMoney({ cents, currency }): string   // pt-BR: '-R$ 1.234,56'
formatOfxAmount({ cents, currency }): string // canonical: '-1234.56'
moneyToNumber({ cents, currency }): number
parseOfxDateTime(raw: string, defaultOffsetMinutes?): OfxDateTimeResult
// '20240115', '20240115120000[-3:BRT]', '[-03:EST]', '[0:GMT]', '[+05:30]',
// '.123' → ISO 8601; clamps invalid fields with a warning, never NaN.
resolveBank(bankId: string): BrazilianBank | undefined
resolveBankByCompe(code: string): BrazilianBank | undefined   // '341', '41' → zero-padded COMPE
resolveBankByIspb(ispb: string): BrazilianBank | undefined    // '60701190'
normalizeBankId(bankId: string): string                       // '41' → '041'
BRAZILIAN_BANKS: readonly BrazilianBank[] // 65 institutions, COMPE + ISPB + names,
                                         // sourced from the Banco Central do Brasil
                                         // STR/COMPE participants list (see src/banks.ts)
```

Encoding detection order: BOM → NUL-interleaved UTF-16 pattern → OFX header
`ENCODING`/`CHARSET` → XML prolog `encoding` → heuristic (valid UTF-8 → UTF-8,
else windows-1252). The windows-1252/ISO-8859-1 decode tables are implemented
in-house (no `TextDecoder` requirement), verified against the WHATWG tables.

Tree building follows OFX semantics, not XML theory: leaf end tags are
optional in the OFX 1.x DTD (silent in the default `sgml` flavor), aggregates
are closed implicitly and reported, elements never nest inside same-name
elements (repeated unclosed `<STMTTRN>` become siblings), and every repair
carries a stable warning code with a 1-based line/column. In `strict` mode
the first problem throws `OfxParseError` with the same code and location.
Property tests guarantee lenient parsing never throws on arbitrary input.

Amounts parse to exact bigint cents (no float is ever involved) from every
convention Brazilian exports mix — `-1234.56`, `-1234,56`, `1.234,56`,
`1,234.56`, `+10`, grouped thousands, `R$` prefixes, stray and NBSP spaces —
with the ambiguity rule from the SPEC (last separator + digit count) and
round-half-away-from-zero beyond two decimals. Dates parse to ISO 8601 with
the `[-3:BRT]`-style offsets real banks emit and a configurable `-03:00`
default; invalid dates clamp best-effort and never produce NaN. `BANKID`
values resolve against the embedded 65-institution Banco Central table
(COMPE + ISPB + names), zero-padding 1–3-digit codes and falling back to
ISPB for 8-digit ones. The performance guard maps 100k transactions through
the whole pipeline in well under 2 s.

## Development

```sh
npm run lint          # eslint (typescript-eslint strict)
npm run format        # prettier --write .
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run test:coverage # vitest with coverage thresholds (>= 90% on core)
npm run build         # tsup: dist/index.js (ESM), dist/index.cjs (CJS), dist/cli.js
```

## License

[MIT](./LICENSE) © Hadagalberto Junior
