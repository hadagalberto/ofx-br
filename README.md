# ofx-br

Robust TypeScript library + CLI to parse bank and credit-card statements exported by
Brazilian banks (OFX 1.x SGML, OFX 2.x XML) and normalize them into a clean, typed
JSON model. Built for the broken files real banks export — never crash, always
report what was fixed. MIT licensed. See [`SPEC.md`](./SPEC.md) for the full plan.

> **Status (v0.1.0):** encoding detection & decoding, mojibake repair and OFX
> 1.x/2.x header parsing are implemented and fully tested. Statement parsing,
> Brazilian normalization (amounts/dates/bank names/Pix), CSV export and the
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
import { detectEncoding, decodeOfx, parseOfxHeader } from 'ofx-br';

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
```

Encoding detection order: BOM → NUL-interleaved UTF-16 pattern → OFX header
`ENCODING`/`CHARSET` → XML prolog `encoding` → heuristic (valid UTF-8 → UTF-8,
else windows-1252). The windows-1252/ISO-8859-1 decode tables are implemented
in-house (no `TextDecoder` requirement), verified against the WHATWG tables.

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
