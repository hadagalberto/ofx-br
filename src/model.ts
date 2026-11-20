/**
 * The normalized document model (SPEC.md "Normalized model").
 *
 * Mapping (milestone 3) fills every structural field; memo enrichment
 * (categories, counterparties, installments) is declared here and populated
 * by the enrichment pass.
 */
import type { Money } from './money.js';
import type { ParseWarning } from './types.js';

/** Account kind a statement covers. */
export type StatementKind = 'bank' | 'creditcard';

/** Whether a transaction moves money in (`credit`) or out (`debit`). */
export type TransactionDirection = 'credit' | 'debit';

/**
 * Category detected from Brazilian memo patterns (Pix, TED, DOC, boleto,
 * tarifa, IOF, juros, estorno, saque, card purchase, generic transfer).
 */
export type PixCategory =
  | 'pix'
  | 'ted'
  | 'doc'
  | 'boleto'
  | 'tarifa'
  | 'iof'
  | 'juros'
  | 'estorno'
  | 'saque'
  | 'card-purchase'
  | 'transfer';

/** Counterparty extracted from memo patterns (`name`, CPF/CNPJ `document`). */
export interface Counterparty {
  name?: string;
  /** CPF/CNPJ when detectable, including masked forms (`***.123.456-**`). */
  document?: string;
}

/** Credit-card installment plan detected from patterns like `PARC 02/10`. */
export interface Installment {
  /** 1-based installment now being charged. */
  current: number;
  /** Total number of installments. */
  total: number;
}

/** `SIGNONMSGSRSV1/SONRS` mapped: login status, server date, FI identifiers. */
export interface SignOn {
  /** `STATUS/CODE`; `0` when missing or not numeric (warned). */
  statusCode: number;
  /** `STATUS/SEVERITY` raw value (`'INFO'`, `'ERROR'`, …). */
  severity: string;
  /** `DTSERVER` as ISO 8601. */
  serverDate?: string;
  /** `FI/ORG`. */
  org?: string;
  /** `FI/FID`. */
  fid?: string;
}

/** Account a statement refers to. */
export interface Account {
  /** OFX `BANKID`, normalized to the zero-padded COMPE code when numeric. */
  bankId?: string;
  /** Resolved from the embedded COMPE/ISPB table, when the bank is Brazilian. */
  bankName?: string;
  /** `BRANCHID` (agência). */
  branchId?: string;
  /** `ACCTID` — empty string (warned) when the export omits it. */
  accountId: string;
  /** `ACCTTYPE` raw (`'CHECKING'`, `'SAVINGS'`). */
  accountType?: string;
}

/** `BANKTRANLIST` period, ISO 8601. */
export interface StatementPeriod {
  /** `DTSTART`. */
  start?: string;
  /** `DTEND`. */
  end?: string;
}

/** A balance as of a date. */
export interface Balance {
  /** Balance amount, exact cents. */
  amount: Money;
  /** `DTASOF` as ISO 8601. */
  date?: string;
}

/** One bank or credit-card statement (`STMTTRNRS/STMTRS` or `CCSTMTTRNRS/CCSTMTRS`). */
export interface Statement {
  /** `'bank'` from `BANKMSGSRSV1`, `'creditcard'` from `CREDITCARDMSGSRSV1`. */
  kind: StatementKind;
  /** `CURDEF` (ISO 4217); `'XXX'` when the export omits it (warned). */
  currency: string;
  /** The account the statement belongs to. */
  account: Account;
  /** Transaction period, when the export declares one. */
  period: StatementPeriod;
  /** `LEDGERBAL`, when present and parsable. */
  ledgerBalance?: Balance;
  /** `AVAILBAL`, when present and parsable. */
  availableBalance?: Balance;
  /** Transactions in document order. */
  transactions: Transaction[];
}

/** One `STMTTRN`, fully normalized. */
export interface Transaction {
  /**
   * Unique, deterministic transaction id: the `FITID` when present, `#2`, `#3`
   * … suffixes for duplicated FITIDs (warned), or `hash-<hex>` when the FITID
   * is missing entirely.
   */
  id: string;
  /** Raw `FITID`, when the export provided one. */
  fitid?: string;
  /** `TRNTYPE` raw value (`'DEBIT'`, `'CREDIT'`, `'XFER'`, …); `''` when missing (warned). */
  type: string;
  /** Money in (`credit`) or out (`debit`); from `TRNTYPE`, else from the amount sign. */
  direction: TransactionDirection;
  /** Exact amount; `TRNAMT` sign preserved as emitted. */
  amount: Money;
  /** `DTPOSTED` as ISO 8601 with offset (default `-03:00`); `''` when missing (warned). */
  postedAt: string;
  /** `DTUSER` as ISO 8601, when present and parsable. */
  userDate?: string;
  /** `NAME` and `MEMO` merged and cleaned (whitespace runs collapsed). */
  description: string;
  /** `NAME`, cleaned. */
  name?: string;
  /** `MEMO`, cleaned. */
  memo?: string;
  /** `CHECKNUM`. */
  checkNumber?: string;
  /** `REFNUM`. */
  refNumber?: string;
  /** Detected Brazilian category (enrichment). */
  category?: PixCategory;
  /** Counterparty extracted from the memo (enrichment). */
  counterparty?: Counterparty;
  /** Installment plan for card purchases (enrichment). */
  installment?: Installment;
}

/** Top-level parse result: the whole normalized OFX document. */
export interface OfxDocument {
  /** OFX header keys, uppercased (empty when the header was missing/garbage). */
  header: Record<string, string>;
  /** OFX major version. */
  version: '1' | '2' | 'unknown';
  /** `SIGNONMSGSRSV1/SONRS`, when the file has one. */
  signOn?: SignOn;
  /** Every statement in the file, in document order. */
  statements: Statement[];
  /** Every repair or oddity found, in pipeline order, with code + location. */
  warnings: ParseWarning[];
  /** Encoding used to decode the bytes: from `parseBuffer`, or `'unknown'` for text input. */
  encoding: string;
}
