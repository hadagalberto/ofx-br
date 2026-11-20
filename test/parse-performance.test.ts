/**
 * Performance guard per SPEC.md: 100k transactions through the FULL pipeline
 * (header → SGML tree → mapping) in under 2 s in plain runs. Under coverage
 * instrumentation the bound relaxes (the profiler adds a 2-4× slowdown) — CI
 * also runs the plain suite, where the strict bound applies.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '../src/index.js';
import { isCoverageRun } from './helpers.js';

describe('parse — performance', () => {
  it('maps 100 000 transactions in under 2 seconds', { timeout: 20_000 }, () => {
    const parts: string[] = [];
    parts.push(
      'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\n' +
        'ENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n\r\n',
    );
    parts.push('<OFX>\r\n<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>');
    parts.push('<DTSERVER>20240101120000[-3:BRT]</SONRS></SIGNONMSGSRSV1>\r\n');
    parts.push('<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL\r\n');
    parts.push(
      '<BANKACCTFROM><BANKID>341<BRANCHID>1234<ACCTID>9999<ACCTTYPE>CHECKING</BANKACCTFROM>\r\n',
    );
    parts.push('<BANKTRANLIST><DTSTART>20240101<DTEND>20241231\r\n');
    for (let i = 0; i < 100_000; i++) {
      parts.push(
        `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20240101120000[-3:BRT]\r\n` +
          `<TRNAMT>-${(i % 100) + 1}.${(i % 100).toString().padStart(2, '0')}\r\n<FITID>TX${i}\r\n` +
          `<MEMO>COMPRA CARTAO & PIX ${i}\r\n</STMTTRN>\r\n`,
      );
    }
    parts.push('</BANKTRANLIST><LEDGERBAL><BALAMT>1234.56<DTASOF>20241231</LEDGERBAL>\r\n');
    parts.push('</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>');
    const doc = parts.join('');
    expect(doc.length).toBeGreaterThan(1_000_000);

    const startedAt = Date.now();
    const result = parse(doc);
    const elapsedMs = Date.now() - startedAt;

    expect(result.warnings).toEqual([]);
    expect(result.statements).toHaveLength(1);
    const statement = result.statements[0];
    expect(statement?.account.bankName).toBe('ITAÚ UNIBANCO S.A.');
    expect(statement?.transactions).toHaveLength(100_000);
    const first = statement?.transactions[0];
    expect(first?.amount.cents).toBe(-100n);
    expect(first?.postedAt).toBe('2024-01-01T12:00:00-03:00');
    expect(statement?.transactions[99_999]?.amount.cents).toBe(-10099n);
    expect(statement?.ledgerBalance?.amount.cents).toBe(123456n);

    // Best-of-3 median: robust to transient GC/system hiccups on CI runners.
    const runs = [elapsedMs];
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      parse(doc);
      runs.push(Date.now() - started);
    }
    const medianMs = runs.sort((a, b) => a - b)[1] ?? elapsedMs;
    const boundMs = isCoverageRun() ? 10_000 : 2_000;
    expect(medianMs).toBeLessThan(boundMs);
  });
});
