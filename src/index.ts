/**
 * ofx-br — robust parser for bank/credit-card statements exported by
 * Brazilian banks (OFX 1.x SGML, OFX 2.x XML).
 *
 * Public API. Memo enrichment (Pix/TED/DOC categories, counterparties,
 * installments, card sign normalization) runs as part of `parse`/
 * `parseBuffer` and is also exposed piecewise. `toJson` and `toCsv` back
 * the CLI's `--format json|csv|ndjson`; everything exported here is stable
 * and fully tested.
 */
export { detectEncoding } from './encoding/detect.js';
export { decodeOfx } from './encoding/decode.js';
export type { DecodeResult, EncodingWarningCode } from './encoding/decode.js';
export type { EncodingDetection, EncodingName, DetectionSource } from './encoding/types.js';
export { parseOfxHeader } from './header.js';
export type {
  HeaderWarningCode,
  OfxHeaderResult,
  ParseHeaderOptions,
  XmlPrologInfo,
} from './header.js';
export { parseSgml } from './sgml/tree.js';
export type {
  SgmlElement,
  SgmlFlavor,
  SgmlParseOptions,
  SgmlParseResult,
  SgmlWarningCode,
} from './sgml/tree.js';
export { parse, parseBuffer } from './parse.js';
export type { ParseOptions } from './parse.js';
export type {
  Account,
  Balance,
  Counterparty,
  Installment,
  OfxDocument,
  PixCategory,
  SignOn,
  Statement,
  StatementKind,
  StatementPeriod,
  Transaction,
  TransactionDirection,
} from './model.js';
export type { MappingWarningCode, MappingOptions, MappingResult } from './mapping.js';
export { mapDocument } from './mapping.js';
export {
  detectInstallment,
  detectMemoCategory,
  enrichMemo,
  enrichTransaction,
  extractCounterparty,
} from './enrich.js';
export type {
  EnrichWarning,
  EnrichWarningSink,
  ExtractCounterpartyOptions,
  MemoEnrichment,
} from './enrich.js';
export {
  BRAZILIAN_BANKS,
  normalizeBankId,
  resolveBank,
  resolveBankByCompe,
  resolveBankByIspb,
} from './banks.js';
export type { BrazilianBank } from './banks.js';
export { formatMoney, formatOfxAmount, moneyToNumber, parseAmountToCents } from './money.js';
export type { AmountParseResult, Money } from './money.js';
export { CSV_COLUMNS, UTF8_BOM, toCsv, toJson, validateDelimiter } from './serialize.js';
export type { CsvLocale, ToCsvOptions, ToJsonOptions } from './serialize.js';
export { parseOfxDateTime, parseTimeZoneOffset } from './datetime.js';
export type { OfxDateWarning, OfxDateWarningCode, OfxDateTimeResult } from './datetime.js';
export { OfxParseError } from './errors.js';
export type { OfxParseErrorOptions } from './errors.js';
export type { ParseWarning } from './types.js';
