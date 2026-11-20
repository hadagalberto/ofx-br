/**
 * Memo enrichment (SPEC.md "Transaction enrichment" + "Credit card"):
 * category detection, counterparty/document extraction, installment
 * detection and credit-card sign normalization.
 *
 * All keyword matching runs on a case- and accent-folded copy of the memo
 * ({@linkcode foldPtBr} keeps a strict 1:1 character mapping, so match
 * positions translate back into the original string and extracted names keep
 * their accents). Detection is heuristic and best-effort, modeled after
 * commonly observed Brazilian memo patterns: it never warns, never throws
 * and never drops information — anything it cannot confidently classify is
 * simply left unset.
 *
 * Category priority (first match wins) is chosen so that a fee always beats
 * the operation it belongs to and a refund beats everything:
 *
 *     estorno > tarifa > iof > juros > saque > pix > ted > doc >
 *     boleto > card-purchase (compra) > transfer (transferência)
 *
 * Counterparty names are captured after an operation keyword
 * ("Pix enviado - FULANO", "TED BANCO X", "compra cartão MERCADO") and cut
 * before a CPF/CNPJ token; CPF/CNPJ values are recognised in full and masked
 * shapes (`***.123.456-**`) and after the `CPF`/`CNPJ` keywords, including
 * bare-digit forms. Credit-card statements normalize the sign convention to
 * "purchases are debits" (negative): `TRNTYPE` decides, a detected purchase
 * or refund overrides a mislabelled type, and only unambiguous intents are
 * rewritten — bank statements keep amounts exactly as emitted.
 */
import type {
  Counterparty,
  Installment,
  PixCategory,
  StatementKind,
  Transaction,
} from './model.js';

/** Fields {@linkcode enrichMemo} can attach to a transaction. */
export interface MemoEnrichment {
  /** Brazilian operation category detected in the memo, when any rule matches. */
  category?: PixCategory;
  /** Counterparty name and/or CPF/CNPJ extracted from the memo. */
  counterparty?: Counterparty;
  /** Installment plan (`PARC 02/10`-style), when detected. */
  installment?: Installment;
}

/** Options for {@linkcode extractCounterparty} and {@linkcode enrichMemo}. */
export interface ExtractCounterpartyOptions {
  /**
   * The `NAME` leaf, when the caller has one: used as the counterparty name
   * for credit-card statements whose MEMO only carries the bank's operation
   * label ("Compra cartão") — the merchant lives in NAME.
   */
  name?: string;
  /** Statement kind the memo belongs to; changes the NAME-fallback rule. Default `'bank'`. */
  kind?: StatementKind;
}

// ------------------------------------------------------------------- folding

/**
 * Folds a memo for keyword matching: ASCII upper → lower and Latin-1
 * accents → base letters ('Ã'→'a', 'Ç'→'c'). Strictly one output character
 * per input character, so match offsets translate back into the source
 * string and captured names can be sliced from the original text.
 */
function foldPtBr(text: string): string {
  const length = text.length;
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x41 && code <= 0x5a) || code >= 0xc0) {
      return foldFrom(text, i);
    }
  }
  return text;
}

/** Latin-1 (0xC0–0xFF) fold table; unmapped code points keep themselves. */
const HIGH_FOLD: readonly string[] = buildHighFold();

function buildHighFold(): string[] {
  const table: string[] = [];
  for (let code = 0xc0; code <= 0xff; code++) {
    table[code] = String.fromCharCode(code);
  }
  const ranges: readonly (readonly [number, number, string])[] = [
    [0xc0, 0xc5, 'a'],
    [0xe0, 0xe5, 'a'],
    [0xc7, 0xc7, 'c'],
    [0xe7, 0xe7, 'c'],
    [0xc8, 0xcb, 'e'],
    [0xe8, 0xeb, 'e'],
    [0xcc, 0xcf, 'i'],
    [0xec, 0xef, 'i'],
    [0xd1, 0xd1, 'n'],
    [0xf1, 0xf1, 'n'],
    [0xd2, 0xd6, 'o'],
    [0xf2, 0xf6, 'o'],
    [0xd9, 0xdc, 'u'],
    [0xf9, 0xfc, 'u'],
    [0xdd, 0xdd, 'y'],
    [0xfd, 0xff, 'y'],
  ];
  for (const [from, to, folded] of ranges) {
    for (let code = from; code <= to; code++) {
      table[code] = folded;
    }
  }
  return table;
}

/** Slow path of {@linkcode foldPtBr}: `from` is the first foldable character. */
function foldFrom(text: string, from: number): string {
  let out = text.slice(0, from);
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x41 && code <= 0x5a) {
      out += String.fromCharCode(code + 0x20);
    } else if (code >= 0xc0 && code <= 0xff) {
      out += HIGH_FOLD[code] ?? String.fromCharCode(code);
    } else {
      out += text.charAt(i);
    }
  }
  return out;
}

/** The word-character class JavaScript regex `\b` uses (ASCII letters, digits, `_`). */
function isWordCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/** True when `word` occurs in `folded` delimited by non-word characters (or string edges). */
function hasWholeWord(folded: string, word: string): boolean {
  for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + 1)) {
    const before = at > 0 ? folded.charCodeAt(at - 1) : 0;
    const end = at + word.length;
    const after = end < folded.length ? folded.charCodeAt(end) : 0;
    if (!isWordCode(before) && !isWordCode(after)) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ category

/** Category rules in priority order over the folded memo (see module doc). */
function categoryOfFolded(folded: string): PixCategory | undefined {
  if (folded.includes('estorn')) {
    return 'estorno';
  }
  if (folded.includes('tarif')) {
    return 'tarifa';
  }
  if (hasWholeWord(folded, 'iof')) {
    return 'iof';
  }
  if (folded.includes('juro')) {
    return 'juros';
  }
  if (folded.includes('saque')) {
    return 'saque';
  }
  if (hasWholeWord(folded, 'pix')) {
    return 'pix';
  }
  if (hasWholeWord(folded, 'ted')) {
    return 'ted';
  }
  if (hasWholeWord(folded, 'doc')) {
    return 'doc';
  }
  if (folded.includes('boleto')) {
    return 'boleto';
  }
  if (hasWholeWord(folded, 'compra') || hasWholeWord(folded, 'compras')) {
    return 'card-purchase';
  }
  if (folded.includes('transf')) {
    return 'transfer';
  }
  return undefined;
}

// --------------------------------------------------------------- installments

/**
 * `PARC 02/10`-style installments. The `parc`/`parcela…` keyword is required
 * so that plain `02/10` (a date fragment) never matches; "parcial" is
 * excluded by the optional `el` branch; a zero-width gap accepts squashed
 * forms like `parc02/10`.
 */
const INSTALLMENT_RE = /\bparc(?:el\w*)?[-\s:.]{0,6}(\d{1,2})\/(\d{1,2})\b/;

/** Largest installment total accepted before the pair is treated as noise. */
const MAX_INSTALLMENT_TOTAL = 48;

function installmentOfFolded(folded: string): Installment | undefined {
  const match = INSTALLMENT_RE.exec(folded);
  if (match === null) {
    return undefined;
  }
  const current = Number.parseInt(match[1] ?? '', 10);
  const total = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(current) || !Number.isInteger(total)) {
    return undefined;
  }
  if (current < 1 || total < 2 || current > total || total > MAX_INSTALLMENT_TOTAL) {
    return undefined;
  }
  return { current, total };
}

// -------------------------------------------------------------------- documents

/** CPF shape with any positions masked: `123.456.789-09`, `***.123.456-**`. */
const CPF_SHAPED_RE = /[\d*]{3}\.[\d*]{3}\.[\d*]{3}-[\d*]{2}/g;
/** CNPJ shape with any positions masked: `00.000.000/0001-91`, digits optionally replaced by `*`. */
const CNPJ_SHAPED_RE = /[\d*]{2}\.[\d*]{3}\.[\d*]{3}\/[\d*]{4}-[\d*]{2}/g;
/** Bare-digit CPF after the keyword: `CPF 12345678909`. */
const CPF_BARE_RE = /\bcpf[- :.]*\d{11}(?!\d)/;
/** Bare-digit CNPJ after the keyword: `CNPJ 12345678000195`. */
const CNPJ_BARE_RE = /\bcnpj[- :.]*\d{14}(?!\d)/;

/** A CPF/CNPJ token found in a folded memo; offsets index that memo. */
interface DocumentMatch {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Digit or `*` — the characters that cannot touch a shaped document token. */
function isMaskBoundaryCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x2a;
}

/** First well-delimited shaped CPF/CNPJ token with at least one visible digit. */
function shapedDocument(folded: string, re: RegExp): DocumentMatch | undefined {
  for (const match of folded.matchAll(re)) {
    const token = match[0];
    if (!/[0-9]/.test(token)) {
      continue; // fully masked ("***.***.***-**") identifies nobody
    }
    const start = match.index;
    const end = start + token.length;
    const before = start > 0 ? folded.charCodeAt(start - 1) : 0;
    if (isMaskBoundaryCode(before)) {
      continue;
    }
    const after = end < folded.length ? folded.charCodeAt(end) : 0;
    if (isMaskBoundaryCode(after)) {
      continue;
    }
    return { value: token, start, end };
  }
  return undefined;
}

/** The bare-digit document after a `CPF`/`CNPJ` keyword. */
function bareDocument(folded: string, re: RegExp, digits: number): DocumentMatch | undefined {
  const match = re.exec(folded);
  if (match === null) {
    return undefined;
  }
  const end = match.index + match[0].length;
  return { value: folded.slice(end - digits, end), start: end - digits, end };
}

/** Earliest CPF/CNPJ token in the memo (full, masked or bare-keyword form). */
function findDocument(folded: string): DocumentMatch | undefined {
  let best: DocumentMatch | undefined;
  for (const candidate of [
    shapedDocument(folded, CPF_SHAPED_RE),
    shapedDocument(folded, CNPJ_SHAPED_RE),
    bareDocument(folded, CPF_BARE_RE, 11),
    bareDocument(folded, CNPJ_BARE_RE, 14),
  ]) {
    if (candidate !== undefined && (best === undefined || candidate.start < best.start)) {
      best = candidate;
    }
  }
  return best;
}

// --------------------------------------------------------------- counterparties

/**
 * Operation keywords whose text may follow a prefix match. Captured names
 * peel these words off their head ("TED EMPRESA X" → "EMPRESA X",
 * "compra parcelada 3/6" → no name at all); words in the middle are kept.
 */
const LEADING_NOISE = new Set([
  'pix',
  'ted',
  'doc',
  'boleto',
  'tarifa',
  'iof',
  'juros',
  'estorno',
  'saque',
  'compra',
  'compras',
  'cartao',
  'transferencia',
  'transf',
  'pagamento',
  'pgto',
  'fatura',
  'faturas',
  'debito',
  'credito',
  'online',
  'enviado',
  'enviada',
  'recebido',
  'recebida',
  'aplicacao',
  'internet',
  'cpf',
  'cnpj',
  'parc',
  'parcela',
  'parcelas',
  'parcelada',
  'parceladas',
  'parcelado',
  'parcelados',
  'parcelamento',
  'via',
  'por',
  'para',
  'de',
  'do',
  'da',
  'no',
  'na',
  'em',
  'pela',
  'app',
  'entre',
  'contas',
  'conta',
  'propria',
  'proprias',
]);

/**
 * Categories that never carry a counterparty: fees, interest and cash
 * withdrawals describe the operation itself, and anything after the keyword
 * ("IOF COMPRA INTERNACIONAL") is not a person or merchant.
 */
const NO_COUNTERPARTY_CATEGORIES = new Set<PixCategory>(['tarifa', 'iof', 'juros', 'saque']);

/** Trailing `CPF`/`CNPJ` keyword (with separators) cut off a name candidate. */
const DOC_TAIL_RE = /[-\s:.|,]*(?:cpf|cnpj)[-\s:.|,]*$/;

/**
 * Prefixes that introduce a counterparty name. Specific phrases first, bare
 * operation words last; for each pattern the *last* match wins, so exports
 * that repeat the bank label in NAME and MEMO ("Pix enviado Pix enviado -
 * FULANO") still yield the person.
 */
const COUNTERPARTY_PREFIXES: readonly RegExp[] = [
  /pix enviado(?: para| ao| a| via| por)?\b/g,
  /pix recebido(?: de| do| da| via| por)?\b/g,
  /ted (?:enviado(?: para)?|recebido(?: de)?|feito(?: para)?|para|ao|a|de|do|da|via)\b/g,
  /doc (?:enviado(?: para)?|recebido(?: de)?|para|ao|a|de|do|da|via)\b/g,
  /transferencia (?:enviada(?: para| via| por)?|recebida(?: de| via| por)?|para|ao|a|de|do|da)\b/g,
  /pix\b/g,
  /ted\b/g,
  /doc\b/g,
  /compras? (?:no |na |em |pela )?cartao\b/g,
  /compras? (?:no|na|em|pela)\b/g,
  /compras?\b/g,
  /boleto(?: pago| pagamento)?\b/g,
  /transf(?:erencia)?\b/g,
];

/** True when any prefix keyword occurs at all — cheap gate before the scan. */
function hasCounterpartyKeyword(folded: string): boolean {
  return (
    folded.includes('pix') ||
    folded.includes('ted') ||
    folded.includes('doc') ||
    folded.includes('compra') ||
    folded.includes('boleto') ||
    folded.includes('transf')
  );
}

/**
 * Cleans a raw capture into a counterparty name: trims separators, peels
 * leading operation keywords, and requires the remainder to start with a
 * letter (rejects leftover amounts, dates and masked documents).
 */
function cleanCandidate(raw: string): string | undefined {
  let text = raw.replace(/^[-\s|:,]+/, '').replace(/[-\s|:,]+$/, '');
  let folded = foldPtBr(text);
  for (;;) {
    const spaceAt = folded.indexOf(' ');
    const word = spaceAt === -1 ? folded : folded.slice(0, spaceAt);
    if (word === '' || !LEADING_NOISE.has(word)) {
      break;
    }
    text = spaceAt === -1 ? '' : text.slice(spaceAt + 1);
    folded = spaceAt === -1 ? '' : folded.slice(spaceAt + 1);
  }
  if (text.length < 2) {
    return undefined;
  }
  if (folded.startsWith('r$')) {
    return undefined; // leftover amount ("PIX ENVIADO R$ 100,00 …")
  }
  if (/\d{4,}/.test(folded)) {
    return undefined; // an account/number fragment, not a name ("NUMERO 12345 …")
  }
  const first = folded.charCodeAt(0);
  if (first < 0x61 || first > 0x7a) {
    return undefined; // must start with a letter (names and merchants do)
  }
  return text;
}

/** Extracts the counterparty name from the merged description, best-effort. */
function nameFromPrefixes(
  description: string,
  folded: string,
  document: DocumentMatch | undefined,
  installmentAt: number | undefined,
): string | undefined {
  for (const prefix of COUNTERPARTY_PREFIXES) {
    const matches = [...folded.matchAll(prefix)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      if (match === undefined) {
        continue;
      }
      const end = match.index + match[0].length;
      const hasDocAhead = document !== undefined && document.start > end;
      // Never let an installment fragment ("PARC 02/10", "PARC12/48") leak
      // into a counterparty name — it is metadata, not a person or merchant.
      const cut = Math.min(
        hasDocAhead ? document.start : folded.length,
        installmentAt ?? folded.length,
      );
      let tail = folded.slice(end, cut);
      if (hasDocAhead) {
        tail = tail.replace(DOC_TAIL_RE, '');
      }
      if (tail === '') {
        continue;
      }
      const name = cleanCandidate(description.slice(end, end + tail.length));
      if (name !== undefined) {
        return name;
      }
    }
  }
  return undefined;
}

/** Counterparty for one memo (folded) + optional `NAME` leaf + statement kind. */
function counterpartyOf(
  description: string,
  folded: string,
  category: PixCategory | undefined,
  name: string | undefined,
  kind: StatementKind,
): Counterparty | undefined {
  if (folded === '' || (category !== undefined && NO_COUNTERPARTY_CATEGORIES.has(category))) {
    return undefined;
  }
  // Documents need dots (shaped forms) or a keyword (bare forms).
  const document =
    folded.includes('.') || folded.includes('cpf') || folded.includes('cnpj')
      ? findDocument(folded)
      : undefined;
  const installmentAt = INSTALLMENT_RE.exec(folded)?.index;
  let counterpartyName: string | undefined;
  if (hasCounterpartyKeyword(folded)) {
    counterpartyName = nameFromPrefixes(description, folded, document, installmentAt);
  }
  if (counterpartyName === undefined && kind === 'creditcard' && name !== undefined) {
    // Card statements carry the operation label in MEMO and the merchant in
    // NAME ("Compra cartão" + "PADARIA PÃO DOCE LTDA"). Installment suffixes
    // sometimes pasted into NAME are metadata, not part of the merchant name.
    const nameFolded = foldPtBr(name);
    const nameInstallmentAt = INSTALLMENT_RE.exec(nameFolded)?.index;
    counterpartyName = cleanCandidate(
      nameInstallmentAt === undefined ? name : name.slice(0, nameInstallmentAt),
    );
  }
  if (counterpartyName === undefined && document === undefined) {
    return undefined;
  }
  const counterparty: Counterparty = {};
  if (counterpartyName !== undefined) {
    counterparty.name = counterpartyName;
  }
  if (document !== undefined) {
    counterparty.document = document.value;
  }
  return counterparty;
}

// ------------------------------------------------------------------- public API

/** Detects the Brazilian operation category of a memo (case/accent-insensitive). */
export function detectMemoCategory(memo: string): PixCategory | undefined {
  return categoryOfFolded(foldPtBr(memo));
}

/** Detects a `PARC 02/10`-style installment plan in a memo, when present. */
export function detectInstallment(memo: string): Installment | undefined {
  return installmentOfFolded(foldPtBr(memo));
}

/**
 * Extracts the counterparty (name and/or CPF/CNPJ, masked forms included)
 * from a memo, modeled after commonly observed Brazilian bank patterns:
 * "Pix enviado - FULANO", "TED BANCO X CNPJ 00.000.000/0001-91",
 * "TRANSF … CPF 12345678909". Fee/interest/withdrawal categories carry no
 * counterparty. For credit-card statements the `name` option is used when
 * the memo only carries the operation label.
 */
export function extractCounterparty(
  memo: string,
  options: ExtractCounterpartyOptions = {},
): Counterparty | undefined {
  const folded = foldPtBr(memo);
  return counterpartyOf(
    memo,
    folded,
    categoryOfFolded(folded),
    options.name,
    options.kind ?? 'bank',
  );
}

/** Everything the enrichment pass can detect in one memo. */
export function enrichMemo(
  description: string,
  options: ExtractCounterpartyOptions = {},
): MemoEnrichment {
  const folded = foldPtBr(description);
  const kind = options.kind ?? 'bank';
  const enrichment: MemoEnrichment = {};
  const category = categoryOfFolded(folded);
  if (category !== undefined) {
    enrichment.category = category;
  }
  const counterparty = counterpartyOf(description, folded, category, options.name, kind);
  if (counterparty !== undefined) {
    enrichment.counterparty = counterparty;
  }
  const installment = installmentOfFolded(folded);
  if (installment !== undefined) {
    enrichment.installment = installment;
  }
  return enrichment;
}

/**
 * Enriches one mapped transaction in place: category, counterparty and
 * installment from its description, plus — for credit-card statements —
 * sign normalization ("purchases are debits"): a `DEBIT`/purchase with a
 * positive amount is flipped negative, a `CREDIT`/refund with a negative
 * amount is flipped positive, and the direction follows the intent. Bank
 * statements are never rewritten.
 */
export function enrichTransaction(transaction: Transaction, kind: StatementKind): void {
  const enrichment = enrichMemo(transaction.description, {
    name: transaction.name,
    kind,
  });
  if (enrichment.category !== undefined) {
    transaction.category = enrichment.category;
  }
  if (enrichment.counterparty !== undefined) {
    transaction.counterparty = enrichment.counterparty;
  }
  if (enrichment.installment !== undefined) {
    transaction.installment = enrichment.installment;
  }
  if (kind === 'creditcard') {
    normalizeCardSign(transaction);
  }
}

/**
 * Credit-card sign convention per the SPEC: purchases are debits. A detected
 * `estorno` outranks the raw `TRNTYPE`, a detected purchase outranks a
 * mislabelled `CREDIT`, and rows with no unambiguous intent are untouched.
 */
function normalizeCardSign(transaction: Transaction): void {
  const upperType = transaction.type.toUpperCase();
  let intent: 'credit' | 'debit';
  if (transaction.category === 'estorno') {
    intent = 'credit';
  } else if (upperType === 'DEBIT' || transaction.category === 'card-purchase') {
    intent = 'debit';
  } else if (upperType === 'CREDIT') {
    intent = 'credit';
  } else {
    return;
  }
  const cents = transaction.amount.cents;
  if (intent === 'debit' && cents > 0n) {
    transaction.amount = { cents: -cents, currency: transaction.amount.currency };
  } else if (intent === 'credit' && cents < 0n) {
    transaction.amount = { cents: -cents, currency: transaction.amount.currency };
  }
  // The direction follows the detected intent even when the amount already
  // had the right sign (e.g. a refund mislabelled `TRNTYPE>DEBIT`).
  transaction.direction = intent;
}
