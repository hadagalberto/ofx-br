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

  it('keeps the single realistic row exact at every truncation point', () => {
    // Invariant, not just totality: BODY has exactly one STMTTRN with
    // TRNAMT -89.90 → -8990 cents (hand-derived). Once that whole token is
    // present, every longer prefix must preserve it exactly, and no prefix
    // may invent a second row. Cuts inside the token legitimately leave a
    // shorter *valid* amount (e.g. "-8" → -800 cents), so those are excluded
    // rather than mislabelled as corruption.
    const amountEnd = BODY.indexOf('-89.90') + '-89.90'.length;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: BODY.length }), (cut) => {
        const rows = parse(BODY.slice(0, cut)).statements.flatMap((s) => s.transactions);
        expect(rows.length).toBeLessThanOrEqual(1);
        if (rows.length === 1 && cut >= amountEnd) {
          expect(rows[0]?.amount.cents).toBe(-8990n);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('drops no transaction and round-trips every amount (constructive properties)', () => {
    // The amount string is formatted here, independently of the library's
    // formatters, from the integer cents we expect to get back.
    const amountText = (cents: bigint): string => {
      const negative = cents < 0n;
      const magnitude = negative ? -cents : cents;
      const text = `${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
      return negative ? `-${text}` : text;
    };
    const centsArb = fc.bigInt({ min: -1_000_000n, max: 1_000_000n });
    const memoArb = fc.stringMatching(/^[A-Z ]{1,16}$/);
    const rowsArb = fc.array(fc.tuple(centsArb, memoArb), { maxLength: 12 });

    fc.assert(
      fc.property(rowsArb, (rows) => {
        const blocks = rows
          .map(
            ([cents, memo], index) =>
              `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240101<TRNAMT>${amountText(cents)}` +
              `<FITID>row-${index}</FITID><MEMO>${memo}</MEMO></STMTTRN>`,
          )
          .join('');
        const text =
          'OFXHEADER:100\nVERSION:102\nENCODING:USASCII\n\n\n' +
          '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL' +
          '<BANKACCTFROM><ACCTID>acc</ACCTID></BANKACCTFROM>' +
          `<BANKTRANLIST>${blocks}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
        const transactions = parse(text).statements.flatMap((s) => s.transactions);
        // No transaction silently dropped: one parsed row per STMTTRN written.
        expect(transactions).toHaveLength(rows.length);
        expect((text.match(/<STMTTRN>/g) ?? []).length).toBe(rows.length);
        // Amounts round-trip exactly, including the sign.
        expect(transactions.map((t) => t.amount.cents)).toEqual(rows.map(([cents]) => cents));
        // Ids stay unique even when memos collide.
        expect(new Set(transactions.map((t) => t.id)).size).toBe(rows.length);
      }),
      { numRuns: 200 },
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
