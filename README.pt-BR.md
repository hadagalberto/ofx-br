# ofx-br

Biblioteca e CLI em TypeScript que analisam extratos bancários e de cartão de crédito exportados
por bancos brasileiros (OFX 1.x SGML e OFX 2.x XML) e os normalizam em um modelo JSON tipado e limpo.
Exports reais do Brasil quebrados de muitas formas: o projeto foi feito para ler o que os bancos
realmente emitem, nunca travar no modo padrão e informar cada correção aplicada.

MIT · [English](./README.md) · [SPEC](./SPEC.md) · [Changelog](./CHANGELOG.md) ·
[Contribuindo](./CONTRIBUTING.md) · [Auditoria da SPEC](./SPEC-AUDIT.md)

## Recursos

- **Codificação**: cabeçalho OFX `CHARSET`/`ENCODING`, BOM, prologo XML, tabelas próprias de
  windows-1252 / ISO-8859-1, UTF-8/16/32 e reparo de mojibake quando o cabeçalho mente.
- **Análise**: tokenizador SGML/XML tolerante a tags sem fechamento, caixa misturada, entidades e
  `&` cru, espaços soltos, bytes NUL, arquivos de uma linha, arquivos truncados e lixo no fim.
  O modo estrito lança `OfxParseError` com linha/coluna no primeiro problema.
- **Modelo normalizado**: sign-on, múltiplos extratos bancários e de cartão, contas, períodos,
  saldos e transações enriquecidas com centavos exatos (`bigint`) e datas ISO 8601.
- **Especificidades brasileiras**: formatos de valor (`-1234,56`, `1.234,56`, `1,234.56`,
  `R$ …`), datas com fuso BRT e sufixos como `[−3:BRT]`, tabela de 65 instituições COMPE/ISPB,
  11 categorias (Pix/TED/DOC/…), extração de CPF/CNPJ inclusive mascarados, parcelas e
  normalização do sinal de compras no cartão.
- **Saída**: `toJson`, `toCsv` (RFC 4180) e CLI completa com `json`, `csv` e `ndjson`.

## Instalação

Não publicamos no npm. Compile a partir do código-fonte (Node ≥ 20):

```sh
npm install
npm run build
```

São gerados `dist/index.js` (ESM), `dist/index.cjs` (CJS), declarações de tipo e o executável
`dist/cli.js`.

## CLI

```sh
node dist/cli.js <arquivos...> [--format json|csv|ndjson] [--out arquivo] [--strict] [--tz -03:00] \
  [--merge] [--dedupe] [--quiet] [--locale pt-BR] [--delimiter ';'] [--bom] [--help]
```

| Opção           | Significado                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--format FMT`  | `json` (padrão): array JSON de documentos. `csv`: uma linha por transação. `ndjson`: um documento JSON compacto por linha. |
| `--out ARQUIVO` | Escreve em `ARQUIVO` em vez da saída padrão.                                                                               |
| `--strict`      | Lança erro no primeiro problema em vez de acumular avisos.                                                                 |
| `--tz OFFSET`   | Fuso aplicado a datas sem fuso explícito (padrão `-03:00`; ex.: `--tz +02:00`).                                            |
| `--merge`       | Combina todos os arquivos em um documento, agrupando extratos por conta e removendo duplicatas por conta + FITID/hash.     |
| `--dedupe`      | Remove transações repetidas por conta + FITID/hash (implícito em `--merge`).                                               |
| `--quiet`       | Não imprime avisos no stderr.                                                                                              |
| `--locale LOC`  | Formato de valor no CSV: `en` → `-1234.56`; `pt-BR` → `-1.234,56`.                                                         |
| `--delimiter C` | Separador de campos do CSV (padrão `,`); use `--delimiter ';'` para planilhas pt-BR.                                       |
| `--bom`         | Prefixa a saída com BOM UTF-8 (compatível com Excel).                                                                      |
| `--help`        | Mostra a ajuda e encerra.                                                                                                  |

Opções podem vir antes ou depois dos nomes de arquivo; `--` encerra a análise de opções. Opções com
valor também aceitam `--opcao=valor`.

Exemplos:

```sh
# Leitura legível de um extrato (avisos no stderr)
node dist/cli.js extrato.ofx --format json

# CSV pronto para Excel em pt-BR
node dist/cli.js extrato.ofx --format csv --locale pt-BR --delimiter ';' --bom --out extrato.csv

# Falha em qualquer entrada malformada; fuso padrão customizado
node dist/cli.js a.ofx b.ofx --strict --tz +02:00

# Combina exportações mensais sem pagar duas vezes o mesmo FITID
node dist/cli.js jan.ofx fev.ofx --merge --out consolidado.json
```

**Códigos de saída:** `0` sucesso, `1` erro de análise/arquivo (inclusive qualquer erro em
`--strict`), `2` erro de uso. Avisos vão para o stderr com código estável e, quando disponível,
linha/coluna; `--quiet` os suprime.

**Detalhes da saída**

- No JSON, `Money.cents` é escrito como **string decimal exata** (JSON não tem literal bigint).
- O CSV segue RFC 4180: campos entre aspas quando necessário, aspas dobradas, quebras CRLF.
  Colunas, nesta ordem:
  `kind,currency,bankId,bankName,branchId,accountId,accountType,periodStart,periodEnd,id,fitid,type,direction,amount,postedAt,userDate,description,name,memo,checkNumber,refNumber,category,counterpartyName,counterpartyDocument,installmentCurrent,installmentTotal`
  (também exportadas como `CSV_COLUMNS`).
- `--merge` preserva FITIDs repetidos dentro de um mesmo extrato como linhas distintas; remove
  apenas a mesma conta + FITID/hash entre arquivos. Cada remoção gera o aviso
  `duplicate-transaction-dropped`.
- O `tsup` preserva o shebang executável, então `./dist/cli.js` funciona após `npm run build` em
  POSIX.

## API da biblioteca

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

### Pipeline de análise

```ts
detectEncoding(bytes: Uint8Array): EncodingDetection
// { encoding: 'windows-1252', source: 'ofx-header', bom: false,
//   declaredLabel: '1252', declaredEncoding: 'windows-1252' }

decodeOfx(bytes: Uint8Array): DecodeResult
// { text, encoding, detection, warnings: [{ code: 'mojibake-repaired', ... }] }

parseOfxHeader(texto: string, opts?: { strict?: boolean }): OfxHeaderResult
// { header: { OFXHEADER: '100', CHARSET: '1252', ... }, version: '1',
//   xmlProlog?, endOffset, warnings }

parseSgml(texto: string, opts?: {
  startOffset?: number;
  flavor?: 'sgml' | 'xml';
  strict?: boolean;
}): SgmlParseResult

parse(texto: string, opts?: {
  strict?: boolean; tz?: string; encoding?: string; verifyBalance?: boolean;
}): OfxDocument

parseBuffer(bytes: Uint8Array, opts?: {
  strict?: boolean; tz?: string; verifyBalance?: boolean;
}): OfxDocument
```

`parseBuffer` é a entrada usual: detecta e decodifica os bytes (inclusive repara mojibake) e depois
executa cabeçalho, árvore e mapeamento. O resultado é um `OfxDocument`:

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
      postedAt: '2024-01-05T08:30:00-03:00',
      description: 'PAGAMENTO BOLETO COMPANHIA ENERGÉTICA',
      category: 'boleto', counterparty: { name: 'COMPANHIA ENERGÉTICA' },
    }],
  }],
  warnings: [{ code: 'unclosed-aggregate', message: '…', line: 12, column: 3 }],
}
```

Observações:

- O modo padrão é tolerante: entrada malformada nunca lança exceção; cada reparo vira um aviso com
  código estável e linha/coluna a partir de 1. Com `strict: true`, o primeiro problema lança
  `OfxParseError` com `code`, `line` e `column`.
- `tz` define o fuso de datas sem sufixo `[offset]`; padrão `-03:00` (BRT).
- FITIDs repetidos dentro de um extrato geram duas linhas (`fitid`, `fitid#2`, …) e um aviso; FITID
  ausente recebe id determinístico `hash-<16 hex>`.
- `verifyBalance: true` compara a soma das transações com `LEDGERBAL` e gera o aviso
  `balance-mismatch`. Ative apenas em exportações que listam todas as movimentações desde a
  abertura da conta.

### Auxiliares de exportação

```ts
toJson(documento | documentos, opts?: { pretty?: boolean }): string
// centavos bigint → strings decimais exatas; 2 espaços por padrão

toCsv(documento | documentos, opts?: {
  delimiter?: string;   // padrão ','
  locale?: 'en' | 'pt-BR';
  bom?: boolean;
}): string
// RFC 4180, CRLF, uma linha por transação
```

### Auxiliares exportados separadamente

```ts
detectMemoCategory(memo): PixCategory | undefined          // pix, ted, doc, boleto, tarifa, iof,
                                                            // juros, estorno, saque, card-purchase, transfer
extractCounterparty(memo, opts?): Counterparty | undefined // nomes, CPF/CNPJ e formas mascaradas
detectInstallment(memo): { current, total } | undefined     // 'PARC 02/10'
enrichMemo(descricao, opts?): MemoEnrichment
enrichTransaction(transacao, kind): void

parseAmountToCents(valor): bigint | undefined   // centavos exatos, todos os formatos BR
formatOfxAmount(money): string                  // '-1234.56'
formatMoney(money): string                      // '-R$ 1.234,56'
moneyToNumber(money): number                    // apenas para exibição
parseOfxDateTime(valor, defaultOffsetMinutes?): OfxDateTimeResult

BRAZILIAN_BANKS: readonly BrazilianBank[]       // 65 instituições, COMPE + ISPB + nomes
resolveBank(id), resolveBankByCompe(code), resolveBankByIspb(ispb), normalizeBankId(id)
```

Ordem de detecção de codificação: BOM → padrão UTF-16 sem BOM → cabeçalho OFX
`ENCODING`/`CHARSET` → prologo XML → heurística (UTF-8 válido → UTF-8, senão windows-1252). A
árvore obedece à semântica OFX, não à teoria XML: tags folha podem ficar sem fechamento no DTD 1.x,
agregados fecham implicitamente com aviso e `<STMTTRN>` repetidos sem fechamento viram irmãos.

## Testes e corpus

O corpus em `test/fixtures/` tem 38 arquivos OFX sintéticos (nomes fictícios; dígitos verificadores
de CPF/CNPJ gerados e validados por `generate.mjs`) modelados após peculiaridades comumente
observadas em exportações brasileiras. Cada um tem `.expected.json` completo e asserções explícitas
de vetores válidos/inválidos em `test/fixtures.test.ts`; veja `test/fixtures/README.md`. Os testes
da CLI executam o `dist/cli.js` compilado como processo real. Testes propriedade (fast-check) cobrem
parsing de valores e a garantia de "nunca lança no modo tolerante"; testes de desempenho analisam
100 mil transações em menos de 2 segundos.

```sh
npm run lint          # ESLint (typescript-eslint strict), avisos como erro
npm run format:check  # Prettier
npm run typecheck     # tsc --noEmit, strict
npm test              # Vitest
npm run test:coverage # Vitest + ≥90% em linhas/funções/statements/branches
npm run build         # tsup: ESM + CJS + declarações + CLI
```

A CI executa lint, checagem de formatação, typecheck, testes com cobertura e build no Node
20/22/24, em Ubuntu e Windows.

## Licença

[MIT](./LICENSE) © Hadagalberto Junior
