/**
 * Full-pipeline totality: lenient `parse`/`parseBuffer` can never throw —
 * on arbitrary strings, on arbitrary bytes, or on truncated fragments of a
 * real Brazilian export. Strict mode still throws `OfxParseError` only.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OfxParseError, parse, parseBuffer } from '../src/index.js';

const BODY = [
  '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>',
  '<DTSERVER>20240115120000[-3:BRT]<FI><ORG>ITAU<FID>0010</FI></SONRS></SIGNONMSGSRSV1>',
  '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
  '<BANKACCTFROM><BANKID>341<BRANCHID>1234<ACCTID>9999<ACCTTYPE>CHECKING</BANKACCTFROM>',
  '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
  '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105120000[-3:BRT]<TRNAMT>-89.90<FITID>1',
  '<NAME>PAGAMENTO BOLETO<MEMO>COMPANHIA ENERGETICA &amp; CIA</STMTTRN>',
  '</BANKTRANLIST><LEDGERBAL><BALAMT>1.234,56<DTASOF>20240131</LEDGERBAL>',
  '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
].join('\r\n');

describe('lenient parse is total (property tests)', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (text) => {
        expect(() => parse(text)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary strings containing hostile tags', () => {
    const hostile = fc
      .array(fc.constantFrom('<', '>', '</', '<STMTTRNRS>', '</OFX>', '&', '<!--', '<?', '\0'), {
        maxLength: 200,
      })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(hostile, (text) => {
        expect(() => parse(text)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary bytes through the whole pipeline', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 2048 }), (bytes) => {
        expect(() => parseBuffer(bytes)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on truncated fragments of a realistic export', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: BODY.length }), (cut) => {
        expect(() => parse(BODY.slice(0, cut))).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });

  it('strict mode only ever throws OfxParseError', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        try {
          parse(text, { strict: true });
          return true;
        } catch (error) {
          return error instanceof OfxParseError;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('deeply nested bodies do not overflow the mapping walk', () => {
    const depth = 50_000;
    const text = `<OFX>${'<A>'.repeat(depth)}${'</A>'.repeat(depth)}</OFX>`;
    expect(() => parse(text)).not.toThrow();
  });
});
