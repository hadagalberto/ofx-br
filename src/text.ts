/**
 * Maps a character offset in a string to a 1-based line/column position.
 *
 * Lines are counted by `\n` only, so CRLF files report standard positions and
 * CR-only files are treated as a single line (real-world OFX files are CRLF
 * or LF; the tokenizer milestone normalizes line endings separately).
 */
export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
