/**
 * Mapping of the generic SGML element tree to the normalized model
 * (SPEC.md pipeline step 4).
 *
 * Walks the tree leniently and in document order: `SONRS` → sign-on, every
 * `STMTTRNRS/STMTRS` → a bank statement, every `CCSTMTTRNRS/CCSTMTRS` → a
 * credit-card statement — wrapper-less bodies, missing wrappers and repeated
 * message sets all map. Missing leaves are tolerated (with warnings);
 * unparsable amounts skip the transaction (a row without an amount is not a
 * transaction); transaction ids stay unique and deterministic: raw `FITID`,
 * `FITID#2` for duplicates (warned), `hash-<16 hex>` when the FITID is
 * missing.
 *
 * The walk is iterative (never overflows the stack on hostile nesting) and
 * warnings are resolved to line/column in a single ascending pass, so a
 * 100k-transaction file with 100k problems still costs O(text).
 */
import { normalizeBankId, resolveBank } from './banks.js';
import { parseOfxDateTime } from './datetime.js';
import type { OfxDateWarningCode, OfxDateTimeResult } from './datetime.js';
import { enrichTransaction } from './enrich.js';
import { OfxParseError } from './errors.js';
import { formatOfxAmount, parseAmountToCents } from './money.js';
import type { AmountWarning } from './money.js';
import type {
  Account,
  Balance,
  SignOn,
  Statement,
  StatementKind,
  StatementPeriod,
  Transaction,
  TransactionDirection,
} from './model.js';
import type { Money } from './money.js';
import type { SgmlElement } from './sgml/tree.js';
import { offsetToLineColumn } from './text.js';
import type { ParseWarning } from './types.js';

/** Warning codes emitted by this module (datetime codes are relayed verbatim). */
export type MappingWarningCode =
  | OfxDateWarningCode
  | 'invalid-amount'
  | 'amount-ambiguous'
  | 'invalid-status-code'
  | 'missing-dtposted'
  | 'missing-trntype'
  | 'missing-account-id'
  | 'missing-currency'
  | 'duplicate-fitid'
  | 'missing-fitid'
  | 'repeated-leaf'
  | 'card-sign-normalized'
  | 'statement-error'
  | 'statement-status-error'
  | 'balance-mismatch'
  | 'warnings-truncated';

/** Options for {@linkcode mapDocument}. */
export interface MappingOptions {
  /** The full decoded text; element offsets index into it, so warning locations stay file-global. */
  text: string;
  /** Offset (minutes east of UTC) for datetimes without a timezone suffix. Default: `-03:00`. */
  defaultOffsetMinutes?: number;
  /** Throw `OfxParseError` on the first mapping problem instead of collecting warnings. */
  strict?: boolean;
  /**
   * Check that the running sum of the statement's transactions equals
   * `LEDGERBAL` and report a mismatch as a `balance-mismatch` warning (in
   * strict mode it throws). Only meaningful when the export lists every
   * movement since the account opening — typical of fresh accounts and
   * full-history credit-card exports. Default: off.
   */
  verifyBalance?: boolean;
}

/** Result of {@linkcode mapDocument}. */
export interface MappingResult {
  /** `SONRS` contents, when the file has a sign-on message. */
  signOn: SignOn | undefined;
  /** Every statement in the file, in document order. */
  statements: Statement[];
  /** Mapping problems, resolved to 1-based line/column. */
  warnings: ParseWarning[];
}

/** Hard cap on recorded mapping warnings; beyond it repairs still happen but are only counted. */
const MAX_WARNINGS = 1000;

/** A problem recorded with a file-global offset; line/column resolves at the end. */
interface PendingWarning {
  readonly offset: number;
  readonly code: MappingWarningCode;
  readonly message: string;
}

/** Collects mapping problems, or throws on the first one in strict mode. */
class WarningSink {
  private readonly pending: PendingWarning[] = [];
  private suppressed = 0;

  constructor(
    private readonly text: string,
    private readonly strict: boolean,
  ) {}

  add(code: MappingWarningCode, message: string, offset: number): void {
    if (this.strict) {
      const { line, column } = offsetToLineColumn(this.text, offset);
      throw new OfxParseError(message, { code, line, column });
    }
    if (this.pending.length >= MAX_WARNINGS) {
      this.suppressed++;
      return;
    }
    this.pending.push({ offset, code, message });
  }

  /** Sorts by offset, resolves line/column in one ascending pass, appends the truncation notice. */
  finish(endOffset: number): ParseWarning[] {
    this.pending.sort((a, b) => a.offset - b.offset);
    const warnings: ParseWarning[] = [];
    const text = this.text;
    let scanned = 0;
    let line = 1;
    let lineStart = 0;
    for (const entry of this.pending) {
      if (entry.offset < scanned) {
        // Defensive: can only happen for out-of-order input, never produced here.
        const resolved = offsetToLineColumn(text, entry.offset);
        warnings.push({
          code: entry.code,
          message: entry.message,
          line: resolved.line,
          column: resolved.column,
        });
        continue;
      }
      for (let i = scanned; i < entry.offset; i++) {
        if (text.charCodeAt(i) === 0x0a) {
          line++;
          lineStart = i + 1;
        }
      }
      scanned = entry.offset;
      warnings.push({
        code: entry.code,
        message: entry.message,
        line,
        column: entry.offset - lineStart + 1,
      });
    }
    if (this.suppressed > 0) {
      for (let i = scanned; i < endOffset; i++) {
        if (text.charCodeAt(i) === 0x0a) {
          line++;
          lineStart = i + 1;
        }
      }
      warnings.push({
        code: 'warnings-truncated',
        message: `${this.suppressed} further problem(s) were found and repaired, but not reported (warning limit of ${MAX_WARNINGS} reached)`,
        line,
        column: Math.max(1, endOffset - lineStart + 1),
      });
    }
    return warnings;
  }
}

// ----------------------------------------------------------------- tree helpers

/** First child element with the given name, or `undefined`. */
function firstChild(element: SgmlElement, name: string): SgmlElement | undefined {
  for (const child of element.children) {
    if (child.name === name) {
      return child;
    }
  }
  return undefined;
}

/** All child elements with the given name, in document order. */
function childrenNamed(element: SgmlElement, name: string): SgmlElement[] {
  const out: SgmlElement[] = [];
  for (const child of element.children) {
    if (child.name === name) {
      out.push(child);
    }
  }
  return out;
}

/** Text of the first child with the given name (already edge-trimmed by the tree builder). */
function childText(element: SgmlElement, name: string): string | undefined {
  const child = firstChild(element, name);
  return child?.text;
}

/** Collapses whitespace runs (NBSP included) to single spaces and trims; `undefined` when nothing remains. */
function cleanText(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** `NAME` first, `MEMO` as detail, deduplicated when the bank repeats one in both. */
function mergeDescription(name: string | undefined, memo: string | undefined): string {
  if (name === undefined) {
    return memo ?? '';
  }
  if (memo === undefined) {
    return name;
  }
  return name === memo ? name : `${name} ${memo}`;
}

/** FNV-1a 64 over UTF-16 code units — deterministic across platforms, used for ids when FITID is missing. */
function fnv64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Deterministic id for a transaction whose FITID is missing or empty. */
function hashTransaction(stmttrn: SgmlElement): string {
  const raw = [
    childText(stmttrn, 'TRNTYPE') ?? '',
    childText(stmttrn, 'TRNAMT') ?? '',
    childText(stmttrn, 'DTPOSTED') ?? '',
    childText(stmttrn, 'DTUSER') ?? '',
    childText(stmttrn, 'NAME') ?? '',
    childText(stmttrn, 'MEMO') ?? '',
    childText(stmttrn, 'CHECKNUM') ?? '',
    childText(stmttrn, 'REFNUM') ?? '',
  ].join('\u0000');
  return `hash-${fnv64Hex(raw)}`;
}

/** Relays amount-interpretation warnings (e.g. `10.500`) into the mapping sink. */
function amountWarnings(sink: WarningSink, offset: number): (warning: AmountWarning) => void {
  return (warning: AmountWarning) => {
    sink.add(warning.code, warning.message, offset);
  };
}

// ------------------------------------------------------------------ date relay

/** Parses an OFX date leaf and relays its warnings into the sink. */
function mapDate(
  raw: string | undefined,
  element: SgmlElement | undefined,
  sink: WarningSink,
  defaultOffsetMinutes: number,
): OfxDateTimeResult {
  if (raw === undefined) {
    return { dateOnly: false, warnings: [] };
  }
  const parsed = parseOfxDateTime(raw, defaultOffsetMinutes);
  for (const warning of parsed.warnings) {
    sink.add(warning.code, warning.message, element?.offset ?? 0);
  }
  return parsed;
}

// ------------------------------------------------------------------- sign-on

/** Maps `SONRS`: status, severity, server date and FI identifiers. */
function mapSignOn(sonrs: SgmlElement, sink: WarningSink, defaultOffsetMinutes: number): SignOn {
  const status = firstChild(sonrs, 'STATUS');
  const rawCode = status !== undefined ? childText(status, 'CODE') : undefined;
  let statusCode = 0;
  if (rawCode === undefined || !/^\d+$/.test(rawCode)) {
    sink.add(
      'invalid-status-code',
      `Sign-on status code ${JSON.stringify(rawCode ?? '')} is missing or not a number; used 0`,
      status?.offset ?? sonrs.offset,
    );
  } else {
    statusCode = Number.parseInt(rawCode, 10);
  }
  const severitySource = status ?? sonrs;
  const severity = childText(severitySource, 'SEVERITY') ?? '';

  const serverDate = mapDate(
    childText(sonrs, 'DTSERVER'),
    firstChild(sonrs, 'DTSERVER'),
    sink,
    defaultOffsetMinutes,
  );
  const fi = firstChild(sonrs, 'FI');
  const org = fi !== undefined ? cleanText(childText(fi, 'ORG')) : undefined;
  const fid = fi !== undefined ? cleanText(childText(fi, 'FID')) : undefined;

  const signOn: SignOn = { statusCode, severity };
  if (serverDate.iso !== undefined) {
    signOn.serverDate = serverDate.iso;
  }
  if (org !== undefined) {
    signOn.org = org;
  }
  if (fid !== undefined) {
    signOn.fid = fid;
  }
  return signOn;
}

// ------------------------------------------------------------------ statement

/** Maps `BANKACCTFROM` (bank) or `CCACCTFROM` (credit card) into the account model. */
function mapAccount(response: SgmlElement, kind: StatementKind, sink: WarningSink): Account {
  const aggregateName = kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM';
  const from = firstChild(response, aggregateName);
  if (from === undefined) {
    sink.add(
      'missing-account-id',
      `No <${aggregateName}> aggregate in the statement; account identifiers are empty`,
      response.offset,
    );
    return { accountId: '' };
  }
  const accountId = childText(from, 'ACCTID') ?? '';
  if (accountId === '') {
    sink.add(
      'missing-account-id',
      '<ACCTID> is missing or empty in the account aggregate',
      from.offset,
    );
  }
  const account: Account = { accountId };

  if (kind === 'bank') {
    const rawBankId = childText(from, 'BANKID');
    if (rawBankId !== undefined && rawBankId !== '') {
      account.bankId = normalizeBankId(rawBankId);
      const bank = resolveBank(rawBankId);
      if (bank !== undefined) {
        account.bankName = bank.shortName;
      }
    }
    const branchId = cleanText(childText(from, 'BRANCHID'));
    if (branchId !== undefined) {
      account.branchId = branchId;
    }
  }
  const accountType = cleanText(childText(from, 'ACCTTYPE'));
  if (accountType !== undefined) {
    account.accountType = accountType;
  }
  return account;
}

/** Maps `LEDGERBAL`/`AVAILBAL`; `undefined` (warned) when the amount is unparsable. */
function mapBalance(
  element: SgmlElement | undefined,
  currency: string,
  sink: WarningSink,
  defaultOffsetMinutes: number,
): Balance | undefined {
  if (element === undefined) {
    return undefined;
  }
  const rawAmount = childText(element, 'BALAMT') ?? '';
  const cents = parseAmountToCents(rawAmount, amountWarnings(sink, element.offset));
  if (cents === undefined) {
    sink.add(
      'invalid-amount',
      `Balance amount ${JSON.stringify(rawAmount)} could not be parsed; the balance was skipped`,
      element.offset,
    );
    return undefined;
  }
  const amount: Money = { cents, currency };
  const asOf = mapDate(
    childText(element, 'DTASOF'),
    firstChild(element, 'DTASOF'),
    sink,
    defaultOffsetMinutes,
  );
  const balance: Balance = { amount };
  if (asOf.iso !== undefined) {
    balance.date = asOf.iso;
  }
  return balance;
}

/** Per-statement mapping context threaded through the response → statement walk. */
interface StatementContext {
  readonly kind: StatementKind;
  readonly verifyBalance: boolean;
}

/** Maps one `STMTTRN` into a normalized transaction, or `undefined` (warned) when the amount is unparsable. */
function mapTransaction(
  stmttrn: SgmlElement,
  currency: string,
  context: StatementContext,
  sink: WarningSink,
  defaultOffsetMinutes: number,
  seenIds: ReadonlySet<string>,
): Transaction | undefined {
  // A leaf repeated inside one STMTTRN is a broken export: the first value
  // wins, but the discarded copy must be reported instead of silently lost
  // (independent review finding 8).
  const seenLeafNames = new Set<string>();
  for (const child of stmttrn.children) {
    if (seenLeafNames.has(child.name)) {
      sink.add(
        'repeated-leaf',
        `Leaf <${child.name}> appears more than once inside <STMTTRN>; only the first value was kept`,
        child.offset,
      );
    } else {
      seenLeafNames.add(child.name);
    }
  }

  const amountElement = firstChild(stmttrn, 'TRNAMT');
  const rawAmount = amountElement?.text;
  const cents =
    rawAmount !== undefined
      ? parseAmountToCents(rawAmount, amountWarnings(sink, amountElement?.offset ?? stmttrn.offset))
      : undefined;
  if (cents === undefined) {
    sink.add(
      'invalid-amount',
      `Transaction amount ${JSON.stringify(rawAmount ?? '')} is missing or could not be parsed; the transaction was skipped`,
      amountElement?.offset ?? stmttrn.offset,
    );
    return undefined;
  }

  const typeElement = firstChild(stmttrn, 'TRNTYPE');
  const type = typeElement?.text ?? '';
  if (type === '') {
    sink.add(
      'missing-trntype',
      'Transaction has no <TRNTYPE>; the type is recorded as empty',
      typeElement?.offset ?? stmttrn.offset,
    );
  }

  const upperType = type.toUpperCase();
  let direction: TransactionDirection;
  if (upperType === 'CREDIT') {
    direction = 'credit';
  } else if (upperType === 'DEBIT') {
    direction = 'debit';
  } else {
    // XFER, CHECK, OTHER, GENERICCODE…: the amount sign decides.
    direction = cents < 0n ? 'debit' : 'credit';
  }

  const postedElement = firstChild(stmttrn, 'DTPOSTED');
  const rawPosted = postedElement?.text;
  let postedAt = '';
  if (rawPosted !== undefined) {
    postedAt = mapDate(rawPosted, postedElement, sink, defaultOffsetMinutes).iso ?? '';
  } else {
    sink.add(
      'missing-dtposted',
      'Transaction has no <DTPOSTED>; postedAt is recorded as empty',
      postedElement?.offset ?? stmttrn.offset,
    );
  }

  const userElement = firstChild(stmttrn, 'DTUSER');
  const rawUser = userElement?.text;
  const userDate =
    rawUser !== undefined
      ? mapDate(rawUser, userElement, sink, defaultOffsetMinutes).iso
      : undefined;

  const name = cleanText(childText(stmttrn, 'NAME'));
  const memo = cleanText(childText(stmttrn, 'MEMO'));
  const checkNumber = cleanText(childText(stmttrn, 'CHECKNUM'));
  const refNumber = cleanText(childText(stmttrn, 'REFNUM'));

  // Ids: FITID when the export provides one; a deterministic hash otherwise.
  // Collisions get a `#2`, `#3`… suffix; only *FITID* duplicates warn —
  // identical fitid-less rows are separate real transactions (recurring
  // payments) and are made unique silently.
  const rawFitid = childText(stmttrn, 'FITID');
  const fitid = rawFitid !== undefined && rawFitid !== '' ? rawFitid : undefined;
  if (fitid === undefined) {
    // The synthesized id is deterministic, but the caller must know that no
    // bank identifier existed (independent review finding 10).
    sink.add(
      'missing-fitid',
      'Transaction has no <FITID>; a deterministic content hash was used as its id',
      stmttrn.offset,
    );
  }
  const baseId = fitid ?? hashTransaction(stmttrn);
  let id = baseId;
  if (seenIds.has(baseId)) {
    let suffix = 2;
    while (seenIds.has(`${baseId}#${suffix}`)) {
      suffix++;
    }
    id = `${baseId}#${suffix}`;
    if (fitid !== undefined) {
      sink.add(
        'duplicate-fitid',
        `Duplicate FITID ${JSON.stringify(fitid)} within the statement; the transaction id was made unique as ${JSON.stringify(id)}`,
        stmttrn.offset,
      );
    }
  }

  const transaction: Transaction = {
    id,
    direction,
    type,
    amount: { cents, currency },
    postedAt,
    description: mergeDescription(name, memo),
  };
  if (fitid !== undefined) {
    transaction.fitid = fitid;
  }
  if (userDate !== undefined) {
    transaction.userDate = userDate;
  }
  if (name !== undefined) {
    transaction.name = name;
  }
  if (memo !== undefined) {
    transaction.memo = memo;
  }
  if (checkNumber !== undefined) {
    transaction.checkNumber = checkNumber;
  }
  if (refNumber !== undefined) {
    transaction.refNumber = refNumber;
  }
  // Memo enrichment: category, counterparty, installments and, for credit
  // cards, the "purchases are debits" sign convention. A sign rewrite keeps
  // the emitted amount in `rawAmount` and is reported (review finding 9).
  enrichTransaction(transaction, context.kind, (warning) => {
    sink.add(warning.code, warning.message, stmttrn.offset);
  });
  return transaction;
}

/** Maps `STMTRS`/`CCSTMTRS` into a normalized statement. */
function mapStatement(
  response: SgmlElement,
  context: StatementContext,
  sink: WarningSink,
  defaultOffsetMinutes: number,
): Statement {
  const kind = context.kind;
  const rawCurrency = childText(response, 'CURDEF');
  let currency: string;
  if (rawCurrency === undefined || rawCurrency === '') {
    currency = 'XXX';
    sink.add(
      'missing-currency',
      'No <CURDEF> element in the statement; currency recorded as XXX (no currency)',
      response.offset,
    );
  } else {
    currency = rawCurrency;
  }

  const account = mapAccount(response, kind, sink);

  const period: StatementPeriod = {};
  const tranList = firstChild(response, 'BANKTRANLIST');
  if (tranList !== undefined) {
    const start = mapDate(
      childText(tranList, 'DTSTART'),
      firstChild(tranList, 'DTSTART'),
      sink,
      defaultOffsetMinutes,
    );
    const end = mapDate(
      childText(tranList, 'DTEND'),
      firstChild(tranList, 'DTEND'),
      sink,
      defaultOffsetMinutes,
    );
    if (start.iso !== undefined) {
      period.start = start.iso;
    }
    if (end.iso !== undefined) {
      period.end = end.iso;
    }
  }

  const ledgerElement = firstChild(response, 'LEDGERBAL');
  const ledgerBalance = mapBalance(ledgerElement, currency, sink, defaultOffsetMinutes);
  const availableBalance = mapBalance(
    firstChild(response, 'AVAILBAL'),
    currency,
    sink,
    defaultOffsetMinutes,
  );

  const transactions: Transaction[] = [];
  if (tranList !== undefined) {
    const seenIds = new Set<string>();
    for (const stmttrn of childrenNamed(tranList, 'STMTTRN')) {
      const transaction = mapTransaction(
        stmttrn,
        currency,
        context,
        sink,
        defaultOffsetMinutes,
        seenIds,
      );
      if (transaction !== undefined) {
        transactions.push(transaction);
        seenIds.add(transaction.id);
      }
    }
  }

  // Optional balance check (after enrichment, so card-sign normalization is
  // already applied to the amounts being summed).
  if (context.verifyBalance && ledgerBalance !== undefined) {
    let sum = 0n;
    for (const transaction of transactions) {
      sum += transaction.amount.cents;
    }
    if (sum !== ledgerBalance.amount.cents) {
      const difference = ledgerBalance.amount.cents - sum;
      sink.add(
        'balance-mismatch',
        `Sum of the listed transactions (${formatOfxAmount({ cents: sum, currency })}) does not ` +
          `match the ledger balance (${formatOfxAmount(ledgerBalance.amount)}); difference ` +
          `${formatOfxAmount({ cents: difference, currency })}. verifyBalance assumes the ` +
          `statement lists every movement since the account opening`,
        ledgerElement?.offset ?? response.offset,
      );
    }
  }

  const statement: Statement = { kind, currency, account, period, transactions };
  if (ledgerBalance !== undefined) {
    statement.ledgerBalance = ledgerBalance;
  }
  if (availableBalance !== undefined) {
    statement.availableBalance = availableBalance;
  }
  return statement;
}

/** Maps one `STMTTRNRS`/`CCSTMTTRNRS` into zero or more statements. */
function mapStatementResponse(
  trnrs: SgmlElement,
  context: StatementContext,
  sink: WarningSink,
  defaultOffsetMinutes: number,
): Statement[] {
  const responseName = context.kind === 'bank' ? 'STMTRS' : 'CCSTMTRS';
  const responses = childrenNamed(trnrs, responseName);
  const status = firstChild(trnrs, 'STATUS');
  const rawCode = status !== undefined ? childText(status, 'CODE') : undefined;
  const statusCode =
    rawCode !== undefined && /^\d+$/.test(rawCode) ? Number.parseInt(rawCode, 10) : undefined;

  if (responses.length === 0) {
    const detail = statusCode !== undefined ? ` (transaction status code ${statusCode})` : '';
    sink.add(
      'statement-error',
      `No <${responseName}> aggregate in <${trnrs.name}>${detail}; the statement was skipped`,
      trnrs.offset,
    );
    return [];
  }
  if (statusCode !== undefined && statusCode !== 0) {
    sink.add(
      'statement-status-error',
      `Statement response reports status code ${statusCode} (nonzero means the FI reported a problem)`,
      status?.offset ?? trnrs.offset,
    );
  }
  return responses.map((response) => mapStatement(response, context, sink, defaultOffsetMinutes));
}

// ------------------------------------------------------------------ entry point

/**
 * Maps a parsed element tree to the normalized model pieces handled here:
 * sign-on and statements with their balances and transactions. The document
 * envelope (header, version, encoding) is assembled by the caller.
 */
export function mapDocument(root: SgmlElement, options: MappingOptions): MappingResult {
  const sink = new WarningSink(options.text, options.strict ?? false);
  const defaultOffsetMinutes = options.defaultOffsetMinutes ?? -3 * 60;
  const verifyBalance = options.verifyBalance ?? false;

  let signOn: SignOn | undefined;
  const statements: Statement[] = [];

  // Iterative pre-order walk: the first SONRS wins, STMTTRNRS/CCSTMTTRNRS
  // subtrees are consumed (never descended into), everything else is walked
  // looking for message sets — including wrapper-less bodies.
  const stack: SgmlElement[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    const child = root.children[i];
    if (child !== undefined) {
      stack.push(child);
    }
  }
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) {
      continue;
    }
    if (element.name === 'SONRS') {
      // The first sign-on message wins; repeated ones (broken exports) are ignored.
      signOn ??= mapSignOn(element, sink, defaultOffsetMinutes);
      continue;
    }
    if (element.name === 'STMTTRNRS') {
      statements.push(
        ...mapStatementResponse(
          element,
          { kind: 'bank', verifyBalance },
          sink,
          defaultOffsetMinutes,
        ),
      );
      continue;
    }
    if (element.name === 'CCSTMTTRNRS') {
      statements.push(
        ...mapStatementResponse(
          element,
          { kind: 'creditcard', verifyBalance },
          sink,
          defaultOffsetMinutes,
        ),
      );
      continue;
    }
    for (let i = element.children.length - 1; i >= 0; i--) {
      const child = element.children[i];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }

  return { signOn, statements, warnings: sink.finish(options.text.length) };
}
