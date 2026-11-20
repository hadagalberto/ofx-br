/**
 * CLI implementation (Node-only I/O, per SPEC: the core has no Node APIs).
 *
 * `ofx-br <files...> [--format json|csv|ndjson] [--out file] [--strict]
 * [--tz -03:00] [--merge] [--dedupe] [--quiet] [--locale pt-BR]
 * [--delimiter ;] [--bom] [--help]`
 *
 * Exit codes: 0 ok, 1 parse/file errors, 2 usage errors. Warnings go to
 * stderr unless `--quiet`; the serialized document(s) go to stdout unless
 * `--out` is given.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { OfxParseError } from '../errors.js';
import type { Balance, OfxDocument, Statement, Transaction } from '../model.js';
import { parseBuffer } from '../parse.js';
import { toCsv, toJson, UTF8_BOM, validateDelimiter, type CsvLocale } from '../serialize.js';
import type { ParseWarning } from '../types.js';

/** Output formats accepted by `--format`. */
export type CliFormat = 'json' | 'csv' | 'ndjson';

/** Parsed command-line arguments. */
export interface CliArgs {
  files: string[];
  format: CliFormat;
  out?: string;
  strict: boolean;
  tz?: string;
  merge: boolean;
  dedupe: boolean;
  quiet: boolean;
  locale: CsvLocale;
  delimiter: string;
  bom: boolean;
  help: boolean;
}

export type CliArgsResult = { ok: true; value: CliArgs } | { ok: false; error: string };

export const CLI_USAGE =
  'usage: ofx-br <files...> [--format json|csv|ndjson] [--out file] [--strict] ' +
  '[--tz -03:00] [--merge] [--dedupe] [--quiet] [--locale pt-BR] [--delimiter ;] ' +
  '[--bom] [--help]';

export const CLI_HELP = `${CLI_USAGE}

Parse OFX 1.x/2.x bank and credit-card statements into a normalized model.

Options:
  --format FMT   Output format: json (default), csv or ndjson.
  --out FILE     Write output to FILE instead of stdout.
  --strict       Throw on the first problem instead of collecting warnings.
  --tz OFFSET    Default offset for dates without one (default -03:00).
  --merge        Combine all files into one document and dedupe by account + FITID/hash.
  --dedupe       Drop repeated transactions by account + FITID/hash (also implied by --merge).
  --quiet        Do not print warnings to stderr.
  --locale LOC   CSV amount format: en (-1234.56, default) or pt-BR (-1.234,56).
  --delimiter C  CSV field separator (default ','); e.g. --delimiter ';'.
  --bom          Prefix output with a UTF-8 BOM (Excel-friendly).
  --help         Show this help.

Exit codes: 0 ok, 1 parse/file error, 2 usage error.
Warnings are printed to stderr unless --quiet. JSON output writes bigint
cents as exact decimal strings; CSV has one row per transaction.`;

/** A flag with an optional inline `=value`. */
function splitOption(arg: string): { name: string; value?: string } {
  const equals = arg.indexOf('=');
  if (equals < 0) {
    return { name: arg };
  }
  return { name: arg.slice(0, equals), value: arg.slice(equals + 1) };
}

/** Parses `ofx-br` arguments. Flags may appear before or after file names. */
export function parseCliArgs(argv: readonly string[]): CliArgsResult {
  const files: string[] = [];
  const args: CliArgs = {
    files,
    format: 'json',
    strict: false,
    merge: false,
    dedupe: false,
    quiet: false,
    locale: 'en',
    delimiter: ',',
    bom: false,
    help: false,
  };
  let onlyFiles = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (onlyFiles) {
      files.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyFiles = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      args.help = true;
      continue;
    }
    if (arg === '--strict') {
      args.strict = true;
      continue;
    }
    if (arg === '--merge') {
      args.merge = true;
      continue;
    }
    if (arg === '--dedupe') {
      args.dedupe = true;
      continue;
    }
    if (arg === '--quiet') {
      args.quiet = true;
      continue;
    }
    if (arg === '--bom') {
      args.bom = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      files.push(arg);
      continue;
    }

    const { name, value: inline } = splitOption(arg);
    /** Consumes an inline value or the next argv entry (even if it starts with `-`, e.g. `--tz -03:00`). */
    const takeValue = (setter: (value: string) => void): boolean => {
      if (inline !== undefined) {
        setter(inline);
        return true;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        return false;
      }
      setter(next);
      i++;
      return true;
    };

    switch (name) {
      case '--format': {
        let raw = '';
        if (
          !takeValue((value) => {
            raw = value;
          })
        ) {
          return { ok: false, error: '--format requires a value' };
        }
        if (raw !== 'json' && raw !== 'csv' && raw !== 'ndjson') {
          return { ok: false, error: `invalid format '${raw}' (expected json, csv or ndjson)` };
        }
        args.format = raw;
        break;
      }
      case '--out': {
        let raw = '';
        if (
          !takeValue((value) => {
            raw = value;
          })
        ) {
          return { ok: false, error: '--out requires a value' };
        }
        args.out = raw;
        break;
      }
      case '--tz': {
        let raw = '';
        if (
          !takeValue((value) => {
            raw = value;
          })
        ) {
          return { ok: false, error: '--tz requires a value' };
        }
        args.tz = raw;
        break;
      }
      case '--locale': {
        let raw = '';
        if (
          !takeValue((value) => {
            raw = value;
          })
        ) {
          return { ok: false, error: '--locale requires a value' };
        }
        if (raw !== 'en' && raw !== 'pt-BR') {
          return { ok: false, error: `invalid locale '${raw}' (expected en or pt-BR)` };
        }
        args.locale = raw;
        break;
      }
      case '--delimiter': {
        let raw = '';
        if (
          !takeValue((value) => {
            raw = value;
          })
        ) {
          return { ok: false, error: '--delimiter requires a value' };
        }
        try {
          validateDelimiter(raw);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        args.delimiter = raw;
        break;
      }
      default:
        return { ok: false, error: `unknown option '${name}'` };
    }
  }

  if (files.length === 0 && !args.help) {
    return { ok: false, error: 'no input files given' };
  }
  return { ok: true, value: args };
}

/** Injectable I/O so the CLI logic is testable without spawning processes. */
export interface CliIO {
  readFile(path: string): Uint8Array;
  writeFile(path: string, text: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Real filesystem/stdout/stderr implementation. */
export function createNodeCliIO(): CliIO {
  return {
    readFile: (path) => new Uint8Array(readFileSync(path)),
    writeFile: (path, text) => {
      writeFileSync(path, text, 'utf8');
    },
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

/** A successfully parsed file, kept with its label for warning messages. */
interface ParsedFile {
  file: string;
  document: OfxDocument;
}

/** A warning together with the label of the file it came from. */
interface WarningEntry {
  file: string;
  warning: ParseWarning;
}

interface TransformResult {
  files: ParsedFile[];
  warnings: WarningEntry[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Statements describing the same account are one dedupe/merge group. */
function accountKey(statement: Statement): string {
  const account = statement.account;
  return [
    statement.kind,
    statement.currency,
    account.bankId ?? '',
    account.branchId ?? '',
    account.accountId,
  ].join('|');
}

/** Raw FITID is the dedupe key; synthesized hash ids are already unique. */
function transactionKey(statement: Statement, transaction: Transaction): string {
  return `${accountKey(statement)}|${transaction.fitid ?? transaction.id}`;
}

function duplicateWarning(file: string, id: string): WarningEntry {
  return {
    file,
    warning: {
      code: 'duplicate-transaction-dropped',
      message: `Duplicate transaction '${id}' dropped`,
    },
  };
}

/** Drops repeated (account, FITID/hash) transactions within one file. */
function dedupeFile(parsed: ParsedFile): TransformResult {
  const seen = new Set<string>();
  const warnings: WarningEntry[] = [];
  const statements: Statement[] = [];

  for (const statement of parsed.document.statements) {
    const transactions: Transaction[] = [];
    for (const transaction of statement.transactions) {
      const key = transactionKey(statement, transaction);
      if (seen.has(key)) {
        warnings.push(duplicateWarning(parsed.file, transaction.id));
        continue;
      }
      seen.add(key);
      transactions.push(transaction);
    }
    statements.push({ ...statement, transactions });
  }

  if (warnings.length === 0) {
    return { files: [parsed], warnings };
  }
  return {
    files: [
      {
        file: parsed.file,
        document: {
          ...parsed.document,
          statements,
          warnings: [...parsed.document.warnings, ...warnings.map((entry) => entry.warning)],
        },
      },
    ],
    warnings,
  };
}

/** Picks the balance attached to the statement with the latest period end. */
function latestBalance<T extends Balance>(
  statements: readonly Statement[],
  pick: (statement: Statement) => T | undefined,
): T | undefined {
  let best: T | undefined;
  let bestEnd = '';
  for (const statement of statements) {
    const balance = pick(statement);
    if (balance === undefined) {
      continue;
    }
    const end = statement.period.end ?? balance.date ?? '';
    if (best === undefined || end > bestEnd) {
      best = balance;
      bestEnd = end;
    }
  }
  return best;
}

/** Merges statements for one account across files into a single statement. */
function mergeGroup(group: readonly Statement[]): Statement {
  const first = group[0];
  if (first === undefined) {
    throw new Error('mergeGroup: empty group');
  }
  let start: string | undefined;
  let end: string | undefined;
  for (const statement of group) {
    const from = statement.period.start;
    const to = statement.period.end;
    if (from !== undefined && (start === undefined || from < start)) {
      start = from;
    }
    if (to !== undefined && (end === undefined || to > end)) {
      end = to;
    }
  }
  return {
    ...first,
    period: { start, end },
    ledgerBalance: latestBalance(group, (statement) => statement.ledgerBalance),
    availableBalance: latestBalance(group, (statement) => statement.availableBalance),
    transactions: group.flatMap((statement) => statement.transactions),
  };
}

/** Combines all files into one document, deduping overlapping periods. */
function mergeFiles(files: readonly ParsedFile[]): TransformResult {
  const warnings: WarningEntry[] = [];
  const deduped: ParsedFile[] = [];
  for (const parsed of files) {
    const result = dedupeFile(parsed);
    deduped.push(...result.files);
    warnings.push(...result.warnings);
  }

  const first = deduped[0];
  if (first === undefined) {
    return { files: [], warnings };
  }

  const groups = new Map<string, Statement[]>();
  for (const parsed of deduped) {
    for (const statement of parsed.document.statements) {
      const key = accountKey(statement);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [statement]);
      } else {
        group.push(statement);
      }
    }
  }

  const seen = new Set<string>();
  const statements: Statement[] = [];
  for (const group of groups.values()) {
    const merged = mergeGroup(group);
    const transactions: Transaction[] = [];
    for (const transaction of merged.transactions) {
      const key = transactionKey(merged, transaction);
      if (seen.has(key)) {
        warnings.push(duplicateWarning('<merged>', transaction.id));
        continue;
      }
      seen.add(key);
      transactions.push(transaction);
    }
    statements.push({ ...merged, transactions });
  }

  const header: Record<string, string> = {};
  let version: OfxDocument['version'] = 'unknown';
  let encoding = 'unknown';
  let signOn: OfxDocument['signOn'];
  const allWarnings: ParseWarning[] = [];
  for (const parsed of deduped) {
    Object.assign(header, parsed.document.header);
    if (version === 'unknown' && parsed.document.version !== 'unknown') {
      version = parsed.document.version;
    }
    if (encoding === 'unknown') {
      encoding = parsed.document.encoding;
    }
    signOn ??= parsed.document.signOn;
    allWarnings.push(...parsed.document.warnings);
  }
  for (const entry of warnings) {
    allWarnings.push(entry.warning);
  }

  return {
    files: [
      {
        file: '<merged>',
        document: {
          header,
          version,
          encoding,
          ...(signOn === undefined ? {} : { signOn }),
          statements,
          warnings: allWarnings,
        },
      },
    ],
    warnings,
  };
}

/** Serializes documents according to the CLI options. */
function render(documents: readonly OfxDocument[], args: CliArgs): string {
  let text: string;
  switch (args.format) {
    case 'csv':
      text = toCsv(documents, {
        delimiter: args.delimiter,
        locale: args.locale,
        bom: args.bom,
      });
      break;
    case 'ndjson':
      text = `${documents.map((document) => toJson(document, { pretty: false })).join('\n')}\n`;
      break;
    case 'json':
      text = toJson(documents);
      break;
  }
  if (args.bom && args.format !== 'csv') {
    text = `${UTF8_BOM}${text}`;
  }
  if (!text.endsWith('\n')) {
    text += '\n';
  }
  return text;
}

/**
 * Runs the CLI with the given arguments and I/O; returns the process exit
 * code: 0 success, 1 file/parse errors, 2 usage errors.
 */
export function runCli(argv: readonly string[], io: CliIO): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(`ofx-br: ${parsed.error}\n${CLI_USAGE}\n`);
    return 2;
  }
  const args = parsed.value;
  if (args.help) {
    io.stdout(`${CLI_HELP}\n`);
    return 0;
  }

  const files: ParsedFile[] = [];
  let failed = false;
  for (const file of args.files) {
    let bytes: Uint8Array;
    try {
      bytes = io.readFile(file);
    } catch (error) {
      io.stderr(`ofx-br: cannot read '${file}': ${errorMessage(error)}\n`);
      failed = true;
      continue;
    }
    try {
      files.push({ file, document: parseBuffer(bytes, { strict: args.strict, tz: args.tz }) });
    } catch (error) {
      const where =
        error instanceof OfxParseError && error.line !== undefined && error.column !== undefined
          ? ` (line ${error.line}, column ${error.column})`
          : '';
      const code = error instanceof OfxParseError ? `[${error.code}] ` : '';
      io.stderr(`ofx-br: ${file}: ${code}${errorMessage(error)}${where}\n`);
      failed = true;
    }
  }

  if (files.length === 0) {
    return failed ? 1 : 0;
  }

  const warningLog: WarningEntry[] = [];
  for (const parsedFile of files) {
    for (const warning of parsedFile.document.warnings) {
      warningLog.push({ file: parsedFile.file, warning });
    }
  }

  let transformed = files;
  if (args.merge || args.dedupe) {
    const result = args.merge ? mergeFiles(files) : dedupeAll(files);
    transformed = result.files;
    warningLog.push(...result.warnings);
  }

  const output = render(
    transformed.map((entry) => entry.document),
    args,
  );
  if (args.out === undefined) {
    io.stdout(output);
  } else {
    try {
      io.writeFile(args.out, output);
    } catch (error) {
      io.stderr(`ofx-br: cannot write '${args.out}': ${errorMessage(error)}\n`);
      return 1;
    }
  }

  if (!args.quiet) {
    for (const { file, warning } of warningLog) {
      const location =
        warning.line === undefined || warning.column === undefined
          ? ''
          : ` (line ${warning.line}, column ${warning.column})`;
      io.stderr(`ofx-br: ${file}: [${warning.code}] ${warning.message}${location}\n`);
    }
  }

  return failed ? 1 : 0;
}

/** Applies `--dedupe` to every file independently. */
function dedupeAll(files: readonly ParsedFile[]): TransformResult {
  const result: TransformResult = { files: [], warnings: [] };
  for (const parsed of files) {
    const deduped = dedupeFile(parsed);
    result.files.push(...deduped.files);
    result.warnings.push(...deduped.warnings);
  }
  return result;
}
