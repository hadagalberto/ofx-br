/**
 * Canonical encoding names produced by detection. A single canonical name is
 * used regardless of how the encoding was declared (`1252`, `WINDOWS-1252`,
 * `CP1252`, … all map to `'windows-1252'`).
 */
export type EncodingName =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'utf-32le'
  | 'utf-32be'
  | 'windows-1252'
  | 'iso-8859-1'
  | 'us-ascii';

/** How the encoding decision was reached. */
export type DetectionSource =
  'empty' | 'bom' | 'utf16-pattern' | 'ofx-header' | 'xml-prolog' | 'utf8-heuristic' | 'fallback';

/**
 * The result of {@linkcode detectEncoding}: what was decided, where the
 * decision came from, and what the file itself declared.
 */
export interface EncodingDetection {
  /** Canonical encoding that will be used to decode the bytes. */
  encoding: EncodingName;
  /** Where the decision came from (most to least authoritative: bom, header, prolog, heuristics). */
  source: DetectionSource;
  /** True when a byte-order mark was present (it is stripped when decoding). */
  bom: boolean;
  /** Raw charset label as written by the exporter, e.g. `'1252'` or `'UTF-8'`. */
  declaredLabel?: string;
  /** Canonical form of {@linkcode declaredLabel}; undefined when the label is unknown or unreliable. */
  declaredEncoding?: EncodingName | undefined;
}

/** A charset declaration found in an OFX header or XML prolog. */
export interface DeclaredCharset {
  /** Raw label as written by the exporter. */
  label: string;
  /** Canonical encoding, or undefined when the label is not recognized. */
  encoding: EncodingName | undefined;
  /** Where the declaration was found. */
  origin: 'ofx-header' | 'xml-prolog';
}
