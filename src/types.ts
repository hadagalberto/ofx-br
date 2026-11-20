/**
 * A non-fatal problem found while reading or parsing an OFX file.
 *
 * The default mode is lenient: nothing throws, every repair or oddity is
 * collected here so callers can report what was fixed. With `strict: true`
 * the first problem throws an {@linkcode OfxParseError} instead.
 */
export interface ParseWarning {
  /** Stable machine-readable identifier, e.g. `'mojibake-repaired'`. */
  code: string;
  /** Human-readable description of what was found and what was done. */
  message: string;
  /**
   * 1-based line in the decoded text, when the warning has a textual
   * location. Byte-level warnings (encoding detection) carry no location.
   */
  line?: number;
  /** 1-based column in the decoded text, when the warning has a textual location. */
  column?: number;
}
