import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeCliIO, parseCliArgs, runCli, type CliIO } from '../src/node/cli.js';
import { OfxParseError } from '../src/errors.js';
import { detectEncoding, decodeOfx, parseOfxHeader } from '../src/index.js';
import { OFX1_HEADER_1252, OFX_BODY, utf8Bytes } from './helpers.js';

function fakeIO(
  files: Record<string, Uint8Array | Error | string>,
): CliIO & { stdoutText: string; stderrText: string } {
  const io = {
    stdoutText: '',
    stderrText: '',
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
    stdout(text: string): void {
      io.stdoutText += text;
    },
    stderr(text: string): void {
      io.stderrText += text;
    },
  };
  return io;
}

describe('parseCliArgs', () => {
  it('parses files and --quiet in any order', () => {
    expect(parseCliArgs(['a.ofx', '--quiet', 'b.ofx'])).toEqual({
      ok: true,
      value: { files: ['a.ofx', 'b.ofx'], quiet: true },
    });
    expect(parseCliArgs(['--quiet', 'a.ofx'])).toEqual({
      ok: true,
      value: { files: ['a.ofx'], quiet: true },
    });
    expect(parseCliArgs(['a.ofx', 'b.ofx'])).toEqual({
      ok: true,
      value: { files: ['a.ofx', 'b.ofx'], quiet: false },
    });
  });

  it('treats everything after -- as file names', () => {
    expect(parseCliArgs(['--', '--quiet', 'weird.ofx'])).toEqual({
      ok: true,
      value: { files: ['--quiet', 'weird.ofx'], quiet: false },
    });
  });

  it('rejects unknown options', () => {
    const result = parseCliArgs(['--format', 'csv']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--format');
    }
  });

  it('rejects empty input', () => {
    const result = parseCliArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('no input files given');
    }
  });
});

describe('runCli', () => {
  const ofxBytes = utf8Bytes(OFX1_HEADER_1252 + OFX_BODY);

  it('exits 2 with usage on stderr for bad arguments', () => {
    const io = fakeIO({});
    const code = runCli([], io);
    expect(code).toBe(2);
    expect(io.stderrText).toContain('no input files given');
    expect(io.stderrText).toContain('usage: ofx-br');
    expect(io.stdoutText).toBe('');
  });

  it('exits 0 and prints a JSON report per file', () => {
    const io = fakeIO({ 'stmt.ofx': ofxBytes });
    const code = runCli(['stmt.ofx'], io);
    expect(code).toBe(0);
    expect(io.stderrText).toBe('');
    const parsed = JSON.parse(io.stdoutText) as {
      files: {
        file: string;
        encoding: string;
        detection: { encoding: string; source: string; bom: boolean };
        version: string;
        header: Record<string, string>;
        warnings: { code: string }[];
      }[];
    };
    expect(parsed.files).toHaveLength(1);
    const report = parsed.files[0];
    expect(report?.file).toBe('stmt.ofx');
    expect(report?.encoding).toBe('windows-1252');
    expect(report?.detection.source).toBe('ofx-header');
    expect(report?.version).toBe('1');
    expect(report?.header.CHARSET).toBe('1252');
    expect(report?.warnings).toEqual([]);
  });

  it('reports decode and header warnings per file, to stderr unless quiet', () => {
    // Header lies about charset: expect a mojibake warning on stderr.
    const lying = utf8Bytes(
      'OFXHEADER:100\r\nENCODING:USASCII\r\nCHARSET:1252\r\n\r\n<OFX>Café ção</OFX>',
    );
    const io = fakeIO({ 'lie.ofx': lying });
    const code = runCli(['lie.ofx'], io);
    expect(code).toBe(0);
    expect(io.stderrText).toContain('[mojibake-repaired]');
    expect(io.stderrText).toContain('lie.ofx');

    const quietIo = fakeIO({ 'lie.ofx': lying });
    expect(runCli(['lie.ofx', '--quiet'], quietIo)).toBe(0);
    expect(quietIo.stderrText).toBe('');
  });

  it('reports missing-header warnings with line/column information', () => {
    const io = fakeIO({ 'nohdr.ofx': utf8Bytes(OFX_BODY) });
    expect(runCli(['nohdr.ofx'], io)).toBe(0);
    expect(io.stderrText).toContain('[missing-header]');
    expect(io.stderrText).toContain('line 1');
  });

  it('continues past unreadable files and exits 1 at the end', () => {
    const io = fakeIO({ 'ok.ofx': ofxBytes });
    const code = runCli(['ok.ofx', 'missing.ofx'], io);
    expect(code).toBe(1);
    expect(io.stderrText).toContain("cannot read 'missing.ofx'");
    const parsed = JSON.parse(io.stdoutText) as { files: { file: string }[] };
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.file).toBe('ok.ofx');
  });

  it('handles multiple files in one report', () => {
    const io = fakeIO({ 'a.ofx': ofxBytes, 'b.ofx': ofxBytes });
    expect(runCli(['a.ofx', 'b.ofx'], io)).toBe(0);
    const parsed = JSON.parse(io.stdoutText) as { files: unknown[] };
    expect(parsed.files).toHaveLength(2);
  });

  it('handles empty files without crashing', () => {
    const io = fakeIO({ 'empty.ofx': new Uint8Array(0) });
    expect(runCli(['empty.ofx'], io)).toBe(0);
    const parsed = JSON.parse(io.stdoutText) as {
      files: { encoding: string; warnings: { code: string }[] }[];
    };
    expect(parsed.files[0]?.encoding).toBe('utf-8');
    expect(parsed.files[0]?.warnings.map((w) => w.code)).toEqual(['missing-header']);
  });

  it('survives non-Error throws from the I/O layer', () => {
    const io = fakeIO({ 'weird.ofx': 'EBUSY: device busy' });
    expect(runCli(['weird.ofx'], io)).toBe(1);
    expect(io.stderrText).toContain('EBUSY: device busy');
  });
});

describe('createNodeCliIO (real filesystem)', () => {
  it('reads a file from disk and produces the same report as the public API', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-br-cli-'));
    try {
      const file = join(dir, 'stmt.ofx');
      writeFileSync(file, utf8Bytes(OFX1_HEADER_1252 + OFX_BODY));
      const real = createNodeCliIO();
      const bytes = real.readFile(file);
      expect(detectEncoding(bytes).encoding).toBe('windows-1252');

      // Smoke-test the default stream sinks (empty writes produce no output).
      real.stdout('');
      real.stderr('');

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const collecting: CliIO = {
        readFile: (path) => real.readFile(path),
        stdout: (t) => stdoutChunks.push(t),
        stderr: (t) => stderrChunks.push(t),
      };
      expect(runCli([file], collecting)).toBe(0);
      expect(stderrChunks.join('')).toBe('');
      const report = JSON.parse(stdoutChunks.join('')) as {
        files: { file: string; version: string; header: Record<string, string> }[];
      };
      expect(report.files[0]?.file).toBe(file);
      expect(report.files[0]?.version).toBe('1');
      expect(report.files[0]?.header.OFXHEADER).toBe('100');
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
