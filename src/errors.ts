/** Options accepted by {@linkcode OfxParseError}. */
export interface OfxParseErrorOptions {
  /** 1-based line where the problem was detected. */
  line?: number;
  /** 1-based column where the problem was detected. */
  column?: number;
  /** Stable machine-readable code, e.g. `'missing-header'`. */
  code?: string;
  /** Underlying error, if any. */
  cause?: unknown;
}

/**
 * Error thrown in strict mode when an OFX file cannot be parsed.
 * Carries the 1-based line/column of the first problem detected.
 */
export class OfxParseError extends Error {
  readonly line?: number;
  readonly column?: number;
  readonly code: string;

  constructor(message: string, options: OfxParseErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OfxParseError';
    this.line = options.line;
    this.column = options.column;
    this.code = options.code ?? 'parse-error';
  }
}
