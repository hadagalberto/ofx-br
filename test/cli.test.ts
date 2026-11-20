import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_HELP,
  CLI_USAGE,
  createNodeCliIO,
  parseCliArgs,
  runCli,
  type CliIO,
} from '../src/node/cli.js';
import { parseBuffer } from '../src/parse.js';
import { UTF8_BOM } from '../src/serialize.js';
import { detectEncoding, decodeOfx, parseOfxHeader, OfxParseError } from '../src/index.js';
import { OFX1_HEADER_1252, OFX_BODY, utf8Bytes } from './helpers.js';

function fakeIO(files: Record<string, Uint8Array | Error | string>): CliIO & {
  stdoutText: string;
  stderrText: string;
  written: Record<string, string>;
} {
  const io = {
    stdoutText: '',
    stderrText: '',
    written: {} as Record<string, string>,
    readFile(path: string): Uint8Array {
      const entry = files[path];
      if (entry === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      if (entry instanceof Error) {
        throw entry;
      }
      if (typeof entry === 'string') {
        throw entry; // simulate a non-Error throw from the filesystem layer
      }
      return entry;
    },
    writeFile(path: string, text: string): void {
      io.written[path] = text;
    },
    stdout(text: string): void {
      io.stdoutText += text;
    },
    stderr(text: string): void {
      io.stderrText += text;
    },
  };
  return io;
}

/** A clean, self-consistent OFX file; `withTz` lets date tests vary the offset. */
function makeOfx(
  fitid: string,
  amount: string,
  options: {
    tz?: string;
    duplicate?: boolean;
    accountId?: string;
    balance?: string;
    periodEnd?: string;
  } = {},
) {
  const posted = options.tz === undefined ? '20240105' : `20240105120000${options.tz}`;
  const accountId = options.accountId ?? '123';
  const balance = options.balance ?? '90.00';
  const periodEnd = options.periodEnd ?? '20240131';
  const duplicate = options.duplicate
    ? '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240106</DTPOSTED>' +
      `<TRNAMT>-1.00</TRNAMT><FITID>${fitid}</FITID><MEMO>DUP</MEMO></STMTTRN>`
    : '';
  const text = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:NONE',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>' +
      '<DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>' +
      `<BANKACCTFROM><BANKID>341</BANKID><ACCTID>${accountId}</ACCTID></BANKACCTFROM>`,
    `<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>${periodEnd}</DTEND>${duplicate}`,
    `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${posted}</DTPOSTED>` +
      `<TRNAMT>${amount}</TRNAMT><FITID>${fitid}</FITID><MEMO>TESTE</MEMO></STMTTRN>`,
    `</BANKTRANLIST><LEDGERBAL><BALAMT>${balance}</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>` +
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
    '</OFX>',
  ].join('\r\n');
  return utf8Bytes(text);
}

interface JsonReport {
  header: Record<string, string>;
  version: string;
  encoding: string;
  signOn?: { statusCode: number; severity: string };
  statements: {
    kind: string;
    currency: string;
    account: { accountId: string; bankName?: string };
    period: { start?: string; end?: string };
    ledgerBalance?: { amount: { cents: string }; date?: string };
    availableBalance?: { amount: { cents: string }; date?: string };
    transactions: {
      id: string;
      fitid?: string;
      direction: string;
      amount: { cents: string; currency: string };
      postedAt: string;
    }[];
  }[];
  warnings: { code: string; message: string; line?: number; column?: number }[];
}

function jsonDocuments(text: string): JsonReport[] {
  return JSON.parse(text) as JsonReport[];
}

describe('parseCliArgs', () => {
  it('defaults and accepts files in any order', () => {
    expect(parseCliArgs(['a.ofx', 'b.ofx'])).toEqual({
      ok: true,
      value: {
        files: ['a.ofx', 'b.ofx'],
        format: 'json',
        strict: false,
        merge: false,
        dedupe: false,
        quiet: false,
        locale: 'en',
        delimiter: ',',
        bom: false,
        help: false,
      },
    });
    expect(parseCliArgs(['--quiet', 'a.ofx']).ok).toBe(true);
  });

  it('parses every boolean flag', () => {
    const result = parseCliArgs(['a.ofx', '--strict', '--merge', '--dedupe', '--quiet', '--bom']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        strict: true,
        merge: true,
        dedupe: true,
        quiet: true,
        bom: true,
      });
    }
  });

  it('parses value flags as `--flag value` and `--flag=value`', () => {
    const result = parseCliArgs([
      '--format=csv',
      '--out=out.csv',
      '--tz=+02:00',
      '--locale=pt-BR',
      '--delimiter=;',
      'a.ofx',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        format: 'csv',
        out: 'out.csv',
        tz: '+02:00',
        locale: 'pt-BR',
        delimiter: ';',
      });
    }
    const next = parseCliArgs([
      '--format',
      'ndjson',
      '--out',
      'out.ndjson',
      '--tz',
      '-03:00',
      '--locale',
      'en',
      '--delimiter',
      ';',
      'a.ofx',
    ]);
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.value).toMatchObject({
        format: 'ndjson',
        out: 'out.ndjson',
        tz: '-03:00',
        locale: 'en',
        delimiter: ';',
      });
    }
  });

  it('treats everything after -- as file names', () => {
    const result = parseCliArgs(['--', '--quiet', '--format', 'weird.ofx']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files).toEqual(['--quiet', '--format', 'weird.ofx']);
    }
  });

  it('accepts --help and -h without files', () => {
    for (const flag of ['--help', '-h']) {
      const result = parseCliArgs([flag]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.help).toBe(true);
      }
    }
  });

  it('rejects unknown options, missing values and invalid values', () => {
    const cases: [string[], string][] = [
      [['--wat'], 'unknown option'],
      [['--format'], '--format requires a value'],
      [['--out'], '--out requires a value'],
      [['--tz'], '--tz requires a value'],
      [['--locale'], '--locale requires a value'],
      [['--delimiter'], '--delimiter requires a value'],
      [['--format', 'xml'], 'invalid format'],
      [['--locale', 'pt_PT'], 'invalid locale'],
      [['--delimiter', ''], 'invalid CSV delimiter'],
      [['--delimiter', ';;'], 'invalid CSV delimiter'],
      [['--delimiter', '"'], 'invalid CSV delimiter'],
      [['--delimiter', '\n'], 'invalid CSV delimiter'],
      [[], 'no input files given'],
    ];
    for (const [argv, message] of cases) {
      const result = parseCliArgs(argv);
      expect(result.ok, argv.join(' ')).toBe(false);
      if (!result.ok) {
        expect(result.error, argv.join(' ')).toContain(message);
      }
    }
  });
});

describe('runCli', () => {
  it('exits 2 with usage on stderr for bad arguments', () => {
    const io = fakeIO({});
    expect(runCli([], io)).toBe(2);
    expect(io.stderrText).toContain('no input files given');
    expect(io.stderrText).toContain('usage: ofx-br');
    expect(io.stdoutText).toBe('');
  });

  it('prints help and exits 0', () => {
    const io = fakeIO({});
    expect(runCli(['--help'], io)).toBe(0);
    expect(io.stdoutText).toBe(`${CLI_HELP}\n`);
    expect(CLI_USAGE).toContain('usage: ofx-br <files...|->'); // '-' reads stdin
    expect(io.stderrText).toBe('');
  });

  it('emits a JSON array of full documents by default', () => {
    const io = fakeIO({ 'stmt.ofx': makeOfx('A1', '-1234.56') });
    expect(runCli(['stmt.ofx'], io)).toBe(0);
    expect(io.stderrText).toBe('');
    const docs = jsonDocuments(io.stdoutText);
    expect(docs).toHaveLength(1);
    const doc = docs[0]?.statements[0];
    expect(docs[0]?.version).toBe('1');
    expect(docs[0]?.encoding).toBe('us-ascii');
    expect(doc?.account.accountId).toBe('123');
    expect(doc?.transactions[0]).toMatchObject({
      id: 'A1',
      fitid: 'A1',
      direction: 'debit',
      amount: { cents: '-123456', currency: 'BRL' },
    });
  });

  it('emits one compact JSON document per line with --format ndjson', () => {
    const io = fakeIO({ 'a.ofx': makeOfx('A1', '-10'), 'b.ofx': makeOfx('B1', '-20') });
    expect(runCli(['a.ofx', 'b.ofx', '--format', 'ndjson'], io)).toBe(0);
    const lines = io.stdoutText.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.startsWith('{')).toBe(true);
      expect(jsonDocuments(`[${line}]`)).toHaveLength(1);
    }
  });

  it('emits RFC 4180 CSV with one row per transaction', () => {
    const io = fakeIO({ 'stmt.ofx': makeOfx('A1', '-1234.56') });
    expect(runCli(['stmt.ofx', '--format', 'csv'], io)).toBe(0);
    const lines = io.stdoutText.split('\r\n');
    expect(lines[0]).toContain('kind,currency,bankId');
    expect(lines[1]).toContain('A1,A1,DEBIT,debit,-1234.56,2024-01-05');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(3);
  });

  it('supports pt-BR amounts, custom delimiter and a BOM in CSV', () => {
    const io = fakeIO({ 'stmt.ofx': makeOfx('A1', '-1234.56') });
    expect(
      runCli(['stmt.ofx', '--format', 'csv', '--locale', 'pt-BR', '--delimiter', ';', '--bom'], io),
    ).toBe(0);
    expect(io.stdoutText.startsWith(UTF8_BOM)).toBe(true);
    const lines = io.stdoutText.slice(1).split('\r\n');
    expect(lines[0]).toContain('kind;currency;bankId');
    expect(lines[1]).toContain('-1.234,56');
  });

  it('applies --bom to JSON output too', () => {
    const io = fakeIO({ 'stmt.ofx': makeOfx('A1', '-10') });
    expect(runCli(['stmt.ofx', '--bom'], io)).toBe(0);
    expect(io.stdoutText.startsWith(UTF8_BOM)).toBe(true);
  });

  it('writes to --out instead of stdout, and reports write failures', () => {
    const io = fakeIO({ 'stmt.ofx': makeOfx('A1', '-10') });
    expect(runCli(['stmt.ofx', '--out', 'report.json'], io)).toBe(0);
    expect(io.stdoutText).toBe('');
    expect(jsonDocuments(io.written['report.json'] ?? '[]')).toHaveLength(1);

    const failing = fakeIO({ 'stmt.ofx': makeOfx('A1', '-10') });
    failing.writeFile = () => {
      throw new Error('EACCES');
    };
    expect(runCli(['stmt.ofx', '--out', 'no.json'], failing)).toBe(1);
    expect(failing.stderrText).toContain("cannot write 'no.json': EACCES");
  });

  it('sends warnings to stderr unless --quiet', () => {
    const lying = utf8Bytes(
      'OFXHEADER:100\r\nENCODING:USASCII\r\nCHARSET:1252\r\n\r\n<OFX>Café ção</OFX>',
    );
    const io = fakeIO({ 'lie.ofx': lying });
    expect(runCli(['lie.ofx'], io)).toBe(0);
    expect(io.stderrText).toContain('[mojibake-repaired]');
    expect(io.stderrText).toContain('lie.ofx');

    const quietIo = fakeIO({ 'lie.ofx': lying });
    expect(runCli(['lie.ofx', '--quiet'], quietIo)).toBe(0);
    expect(quietIo.stderrText).toBe('');
  });

  it('prints warning locations when available', () => {
    const io = fakeIO({ 'nohdr.ofx': utf8Bytes(OFX_BODY) });
    expect(runCli(['nohdr.ofx'], io)).toBe(0);
    expect(io.stderrText).toContain('[missing-header]');
    expect(io.stderrText).toContain('line 1');
    expect(io.stderrText).toContain('column 1');
  });

  it('continues past unreadable files and exits 1', () => {
    const io = fakeIO({ 'ok.ofx': makeOfx('A1', '-10') });
    expect(runCli(['ok.ofx', 'missing.ofx'], io)).toBe(1);
    expect(io.stderrText).toContain("cannot read 'missing.ofx'");
    expect(jsonDocuments(io.stdoutText)).toHaveLength(1);
  });

  it('survives non-Error throws from the I/O layer', () => {
    const io = fakeIO({ 'weird.ofx': 'EBUSY: device busy' });
    expect(runCli(['weird.ofx'], io)).toBe(1);
    expect(io.stderrText).toContain('EBUSY: device busy');
    expect(io.stdoutText).toBe('');
  });

  it('in strict mode, succeeds on clean input and exits 1 on warnings', () => {
    const clean = fakeIO({ 'clean.ofx': makeOfx('A1', '-10') });
    expect(parseBuffer(clean.readFile('clean.ofx')).warnings).toEqual([]);
    expect(runCli(['clean.ofx', '--strict'], clean)).toBe(0);

    const dirty = fakeIO({ 'dirty.ofx': utf8Bytes(OFX_BODY) });
    expect(runCli(['dirty.ofx', '--strict'], dirty)).toBe(1);
    expect(dirty.stderrText).toContain('missing-header');
    expect(dirty.stdoutText).toBe('');
  });

  it('applies --tz to dates without an explicit offset', () => {
    const io = fakeIO({ 'tz.ofx': makeOfx('A1', '-10', { tz: '' }) });
    expect(runCli(['tz.ofx', '--tz', '+02:00'], io)).toBe(0);
    const doc = jsonDocuments(io.stdoutText)[0];
    expect(doc?.statements[0]?.transactions[0]?.postedAt).toBe('2024-01-05T12:00:00+02:00');
  });

  it('--dedupe keeps distinct transactions that merely share a FITID', () => {
    // Independent review: the duplicate row generated here has a different
    // date, amount and memo from the primary row. A raw FITID is NOT a dedupe
    // key, so both rows must survive. The old assertion of a single row
    // encoded the bug and has been corrected.
    const bytes = makeOfx('A1', '-10', { duplicate: true });
    const plain = fakeIO({ 'dup.ofx': bytes });
    expect(runCli(['dup.ofx'], plain)).toBe(0);
    expect(jsonDocuments(plain.stdoutText)[0]?.statements[0]?.transactions).toHaveLength(2);

    const io = fakeIO({ 'dup.ofx': bytes });
    expect(runCli(['dup.ofx', '--dedupe'], io)).toBe(0);
    expect(jsonDocuments(io.stdoutText)[0]?.statements[0]?.transactions).toHaveLength(2);
    expect(io.stderrText).not.toContain('[duplicate-transaction-dropped]');
  });

  it('--merge combines files and dedupes by account + FITID', () => {
    const files = { 'a.ofx': makeOfx('A1', '-10'), 'b.ofx': makeOfx('A1', '-10') };
    const plain = fakeIO(files);
    expect(runCli(['a.ofx', 'b.ofx'], plain)).toBe(0);
    expect(jsonDocuments(plain.stdoutText)).toHaveLength(2);

    const io = fakeIO(files);
    expect(runCli(['a.ofx', 'b.ofx', '--merge'], io)).toBe(0);
    const docs = jsonDocuments(io.stdoutText);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.statements).toHaveLength(1);
    expect(docs[0]?.statements[0]?.transactions).toHaveLength(1);
    expect(io.stderrText).toContain('[duplicate-transaction-dropped]');
    expect(docs[0]?.statements[0]?.period).toEqual({ start: '2024-01-01', end: '2024-01-31' });
  });

  it('--merge picks balances from the statement with the latest period', () => {
    const io = fakeIO({
      'a.ofx': makeOfx('A1', '-10', { balance: '999.00', periodEnd: '20240110' }),
      'b.ofx': makeOfx('B1', '-20', { balance: '90.00', periodEnd: '20240131' }),
    });
    expect(runCli(['a.ofx', 'b.ofx', '--merge'], io)).toBe(0);
    const doc = jsonDocuments(io.stdoutText)[0];
    expect(doc?.statements).toHaveLength(1);
    expect(doc?.statements[0]?.period).toEqual({ start: '2024-01-01', end: '2024-01-31' });
    expect(doc?.statements[0]?.ledgerBalance?.amount.cents).toBe('9000');
    expect(doc?.statements[0]?.transactions.map((t) => t.id).sort()).toEqual(['A1', 'B1']);
  });

  it('--merge keeps distinct accounts in separate statements', () => {
    const io = fakeIO({
      'a.ofx': makeOfx('A1', '-10'),
      'b.ofx': makeOfx('B1', '-20', { accountId: '456' }),
    });
    expect(runCli(['a.ofx', 'b.ofx', '--merge'], io)).toBe(0);
    const doc = jsonDocuments(io.stdoutText)[0];
    expect(doc?.statements).toHaveLength(2);
    expect(doc?.statements.map((s) => s.account.accountId).sort()).toEqual(['123', '456']);
  });
});

describe('createNodeCliIO (real filesystem)', () => {
  it('reads and writes files on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-br-cli-'));
    try {
      const file = join(dir, 'stmt.ofx');
      const out = join(dir, 'out.json');
      writeFileSync(file, utf8Bytes(OFX1_HEADER_1252 + OFX_BODY));
      const real = createNodeCliIO();
      const bytes = real.readFile(file);
      expect(detectEncoding(bytes).encoding).toBe('windows-1252');

      real.stdout('');
      real.stderr('');

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const collecting: CliIO = {
        readFile: (path) => real.readFile(path),
        writeFile: (path, text) => {
          real.writeFile(path, text);
        },
        stdout: (t) => {
          stdoutChunks.push(t);
        },
        stderr: (t) => {
          stderrChunks.push(t);
        },
      };
      expect(runCli([file, '--out', out], collecting)).toBe(0);
      expect(stdoutChunks.join('')).toBe('');
      expect(jsonDocuments(readFileSync(out, 'utf8'))).toHaveLength(1);
      expect(stderrChunks.join('')).toContain('invalid-status-code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('public API surface', () => {
  it('exposes detectEncoding, decodeOfx, parseOfxHeader and OfxParseError', () => {
    expect(typeof detectEncoding).toBe('function');
    expect(typeof decodeOfx).toBe('function');
    expect(typeof parseOfxHeader).toBe('function');
    expect(new OfxParseError('boom').name).toBe('OfxParseError');
  });

  it('OfxParseError carries code, location and cause', () => {
    const cause = new Error('disk on fire');
    const withCause = new OfxParseError('boom', { code: 'x', line: 3, column: 7, cause });
    expect(withCause.code).toBe('x');
    expect(withCause.line).toBe(3);
    expect(withCause.column).toBe(7);
    expect(withCause.cause).toBe(cause);
    const bare = new OfxParseError('boom');
    expect(bare.code).toBe('parse-error');
    expect(bare.line).toBeUndefined();
    expect(bare.column).toBeUndefined();
    expect(bare.cause).toBeUndefined();
  });

  it('decodeOfx + parseOfxHeader compose into header info for a full file', () => {
    const bytes = utf8Bytes(OFX1_HEADER_1252 + OFX_BODY);
    const decoded = decodeOfx(bytes);
    const header = parseOfxHeader(decoded.text);
    expect(header.version).toBe('1');
    expect(header.header).toEqual(
      expect.objectContaining({ ENCODING: 'USASCII', CHARSET: '1252' }),
    );
  });
});
