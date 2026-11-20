/**
 * CLI implementation (Node-only I/O, per SPEC: the core has no Node APIs).
 *
 * Current surface: `ofx-br <file...> [--quiet]` — reads each file, reports
 * the detected encoding, the OFX header and any warnings as JSON. Statement
 * parsing and format options (`--format csv|ndjson`, `--out`, …) arrive with
 * the parser milestone.
 */
import { readFileSync } from 'node:fs';
import { decodeOfx } from '../encoding/decode.js';
import { detectEncoding } from '../encoding/detect.js';
import { parseOfxHeader } from '../header.js';

/** Parsed command-line arguments. */
export interface CliArgs {
  files: string[];
  quiet: boolean;
}

export type CliArgsResult = { ok: true; value: CliArgs } | { ok: false; error: string };

const USAGE = 'usage: ofx-br <file...> [--quiet]';

/** Parses `ofx-br` arguments. Flags may appear before or after file names. */
export function parseCliArgs(argv: readonly string[]): CliArgsResult {
  const files: string[] = [];
  let quiet = false;
  let onlyFiles = false;
  for (const arg of argv) {
    if (onlyFiles) {
      files.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyFiles = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `unknown option '${arg}'` };
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    return { ok: false, error: 'no input files given' };
  }
  return { ok: true, value: { files, quiet } };
}

/** Per-file result printed by the CLI. */
export interface CliFileResult {
  file: string;
  encoding: string;
  detection: ReturnType<typeof detectEncoding>;
  version: '1' | '2' | 'unknown';
  header: Record<string, string>;
  xmlProlog?: { version?: string; encoding?: string; standalone?: string };
  warnings: { code: string; message: string; line?: number; column?: number }[];
}

/** Injectable I/O so the CLI logic is testable without spawning processes. */
export interface CliIO {
  readFile(path: string): Uint8Array;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Real filesystem/stdout/stderr implementation. */
export function createNodeCliIO(): CliIO {
  return {
    readFile: (path) => new Uint8Array(readFileSync(path)),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Runs the CLI with the given arguments and I/O; returns the process exit
 * code: 0 success, 1 file/parse errors, 2 usage errors. Warnings go to
 * stderr unless `--quiet`.
 */
export function runCli(argv: readonly string[], io: CliIO): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(`ofx-br: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }

  const results: CliFileResult[] = [];
  let failed = false;
  for (const file of parsed.value.files) {
    let bytes: Uint8Array;
    try {
      bytes = io.readFile(file);
    } catch (error) {
      io.stderr(`ofx-br: cannot read '${file}': ${errorMessage(error)}\n`);
      failed = true;
      continue;
    }
    const decoded = decodeOfx(bytes);
    const header = parseOfxHeader(decoded.text);
    results.push({
      file,
      encoding: decoded.encoding,
      detection: decoded.detection,
      version: header.version,
      header: header.header,
      xmlProlog: header.xmlProlog,
      warnings: [...decoded.warnings, ...header.warnings],
    });
  }

  io.stdout(`${JSON.stringify({ files: results }, null, 2)}\n`);

  if (!parsed.value.quiet) {
    for (const result of results) {
      for (const warning of result.warnings) {
        const line = warning.line;
        const column = warning.column;
        const location =
          line === undefined || column === undefined ? '' : ` (line ${line}, column ${column})`;
        io.stderr(`ofx-br: ${result.file}: [${warning.code}] ${warning.message}${location}\n`);
      }
    }
  }

  return failed ? 1 : 0;
}
