/**
 * ofx-br — robust parser for bank/credit-card statements exported by
 * Brazilian banks (OFX 1.x SGML, OFX 2.x XML).
 *
 * Public API. The statement parser (`parse`/`parseBuffer`), normalizers
 * (`toCsv`/`toJson`) and the Brazilian-specific model land with their
 * milestones; everything exported here is stable and fully tested.
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
export { OfxParseError } from './errors.js';
export type { OfxParseErrorOptions } from './errors.js';
export type { ParseWarning } from './types.js';
