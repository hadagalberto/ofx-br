/**
 * Performance guard per SPEC.md: 100k transactions parsed in well under 2 s
 * in plain runs. Under coverage instrumentation the bound relaxes (the
 * profiler adds a 2-4× slowdown) — CI also runs the plain suite, where the
 * strict bound applies.
 */
import { describe, expect, it } from 'vitest';
import { parseSgml } from '../src/index.js';
import { isCoverageRun } from './helpers.js';

describe('parseSgml — performance', () => {
  it('parses 100 000 transactions in under 2 seconds', { timeout: 20_000 }, () => {
    const parts: string[] = [];
    parts.push('<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\r\n');
    for (let i = 0; i < 100_000; i++) {
      parts.push(
        `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20240101120000[-3:BRT]\r\n` +
          `<TRNAMT>-${(i % 100) + 1}.${i % 100}\r\n<FITID>TX${i}\r\n` +
          `<MEMO>COMPRA CARTAO & PIX ${i}\r\n</STMTTRN>\r\n`,
      );
    }
    parts.push('</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>');
    const doc = parts.join('');
    expect(doc.length).toBeGreaterThan(1_000_000);

    const startedAt = Date.now();
    const result = parseSgml(doc);
    const elapsedMs = Date.now() - startedAt;

    expect(result.warnings).toEqual([]);
    const ofx = result.root.children[0];
    const bankTranList = ofx?.children[0]?.children[0]?.children[0]?.children[0];
    expect(bankTranList?.name).toBe('BANKTRANLIST');
    expect(bankTranList?.children.length).toBe(100_000);
    const first = bankTranList?.children[0];
    expect(first?.children.map((c) => c.name)).toEqual([
      'TRNTYPE',
      'DTPOSTED',
      'TRNAMT',
      'FITID',
      'MEMO',
    ]);
    expect(first?.children[0]?.text).toBe('DEBIT');
    expect(first?.children[2]?.text).toBe('-1.0');
    expect(first?.children[4]?.text).toBe('COMPRA CARTAO & PIX 0');

    // Best-of-3 median: robust to transient GC/system hiccups on CI runners.
    const runs = [elapsedMs];
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      parseSgml(doc);
      runs.push(Date.now() - started);
    }
    const medianMs = runs.sort((a, b) => a - b)[1] ?? elapsedMs;
    const boundMs = isCoverageRun() ? 10_000 : 2_000;
    expect(medianMs).toBeLessThan(boundMs);
  });
});
