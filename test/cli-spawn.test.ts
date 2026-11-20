/**
 * End-to-end tests that spawn the *built* CLI (`dist/cli.js`) as a real
 * process, per SPEC's "tests that spawn the built CLI" requirement.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const FIXTURES = join(ROOT, 'test', 'fixtures');

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[]): SpawnResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('built CLI (spawned process)', () => {
  it('uses the artifact built once by vitest globalSetup, with no npm-from-node-path', () => {
    // Regression: the build used to run in `beforeAll` by resolving npm from
    // the Node installation directory, which is absent on hosted Node 20
    // toolcache images. The globalSetup tsup build removes that dependency;
    // `run()` only needs the Node binary itself.
    expect(existsSync(CLI)).toBe(true);
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toMatch(/node_modules[/\\]+npm/);
    expect(source).not.toMatch(/npm[-_]?cli/);
  });

  it('prints help on stdout and exits 0', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: ofx-br <files...>');
    expect(result.stdout).toContain('--delimiter');
    expect(result.stderr).toBe('');
  });

  it('exits 2 with usage on missing arguments', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: ofx-br');
    expect(result.stdout).toBe('');
  });

  it('exits 2 on an unknown flag', () => {
    const result = run(['--format', 'yaml', join(FIXTURES, '01-itau-sgml-1252.ofx')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid format');
  });

  it('parses a fixture and emits a JSON document array on stdout', () => {
    const result = run([join(FIXTURES, '01-itau-sgml-1252.ofx')]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const docs = JSON.parse(result.stdout) as {
      version: string;
      encoding: string;
      statements: { kind: string; transactions: { amount: { cents: string } }[] }[];
    }[];
    expect(docs).toHaveLength(1);
    expect(docs[0]?.version).toBe('1');
    expect(docs[0]?.encoding).toBe('windows-1252');
    expect(docs[0]?.statements[0]?.kind).toBe('bank');
    expect(docs[0]?.statements[0]?.transactions).toHaveLength(4);
    expect(docs[0]?.statements[0]?.transactions[0]?.amount.cents).toBe('-8990');
  });

  it('emits CSV and NDJSON with the same transactions', () => {
    const file = join(FIXTURES, '01-itau-sgml-1252.ofx');
    const csv = run([file, '--format', 'csv']);
    expect(csv.status).toBe(0);
    const lines = csv.stdout.split('\r\n');
    expect(lines[0]).toContain('kind,currency,bankId');
    expect(lines.filter((line) => line.includes('20240105'))).toHaveLength(1);

    const ndjson = run([file, join(FIXTURES, '02-bradesco-brt-lf.ofx'), '--format', 'ndjson']);
    expect(ndjson.status).toBe(0);
    const docs = ndjson.stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(docs).toHaveLength(2);
    expect((docs[0] as { version: string }).version).toBe('1');
  });

  it('writes output to --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-br-spawn-'));
    try {
      const out = join(dir, 'report.csv');
      const result = run([
        join(FIXTURES, '01-itau-sgml-1252.ofx'),
        '--format',
        'csv',
        '--out',
        out,
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(readFileSync(out, 'utf8')).toContain('kind,currency,bankId');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours locale, delimiter and BOM', () => {
    const result = run([
      join(FIXTURES, '01-itau-sgml-1252.ofx'),
      '--format',
      'csv',
      '--locale',
      'pt-BR',
      '--delimiter',
      ';',
      '--bom',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith('\uFEFF')).toBe(true);
    expect(result.stdout).toContain('kind;currency;bankId');
    expect(result.stdout).toContain('-89,90');
  });

  it('uses --tz for dates without an offset', () => {
    const result = run([join(FIXTURES, '37-custom-timezone.ofx'), '--tz', '+02:00']);
    expect(result.status).toBe(0);
    const docs = JSON.parse(result.stdout) as {
      statements: { transactions: { postedAt: string }[] }[];
    }[];
    expect(docs[0]?.statements[0]?.transactions[0]?.postedAt).toBe('2024-01-05T09:00:00+02:00');
  });

  it('exits 1 in strict mode on warnings and 0 on a clean file', () => {
    const clean = run([join(FIXTURES, '01-itau-sgml-1252.ofx'), '--strict']);
    expect(clean.status).toBe(0);

    const dirty = run([join(FIXTURES, '18-no-header-body-only.ofx'), '--strict']);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toBe('');
    expect(dirty.stderr).toContain('missing-header');
  });

  it('--dedupe drops repeated FITIDs kept by the parser', () => {
    const file = join(FIXTURES, '09-duplicate-fitids.ofx');
    const plain = JSON.parse(run([file]).stdout) as {
      statements: { transactions: unknown[] }[];
    }[];
    const dedupedResult = run([file, '--dedupe']);
    expect(dedupedResult.status).toBe(0);
    const deduped = JSON.parse(dedupedResult.stdout) as {
      statements: { transactions: unknown[] }[];
    }[];
    expect(deduped[0]?.statements[0]?.transactions.length).toBeLessThan(
      plain[0]?.statements[0]?.transactions.length ?? 0,
    );
    expect(dedupedResult.stderr).toContain('[duplicate-transaction-dropped]');
  });

  it('--merge combines files and removes overlapping FITIDs', () => {
    const file = join(FIXTURES, '01-itau-sgml-1252.ofx');
    const result = run([file, file, '--merge']);
    expect(result.status).toBe(0);
    const docs = JSON.parse(result.stdout) as {
      statements: { transactions: { id: string }[] }[];
    }[];
    expect(docs).toHaveLength(1);
    expect(docs[0]?.statements).toHaveLength(1);
    expect(docs[0]?.statements[0]?.transactions).toHaveLength(4);
  });

  it('suppresses warnings with --quiet', () => {
    const file = join(FIXTURES, '18-no-header-body-only.ofx');
    expect(run([file]).stderr).toContain('missing-header');
    const quiet = run([file, '--quiet']);
    expect(quiet.status).toBe(0);
    expect(quiet.stderr).toBe('');
  });

  it('exits 1 for an unreadable file', () => {
    const result = run([join(FIXTURES, 'does-not-exist.ofx')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read');
  });
});
