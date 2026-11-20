/**
 * Amount parsing (SPEC.md "Brazilian specifics — Amounts"): every format
 * real Brazilian exports emit, exact bigint cents, ambiguity resolved by the
 * last separator + digit count, and fast-check round trips through both the
 * canonical and the pt-BR formatters.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatMoney, formatOfxAmount, moneyToNumber, parseAmountToCents } from '../src/index.js';
import type { Money } from '../src/index.js';

const B = (cents: number): bigint => BigInt(cents);

describe('parseAmountToCents — SPEC formats', () => {
  it.each([
    // The four canonical decimal conventions from the SPEC.
    ['-1234.56', -123456n],
    ['-1234,56', -123456n],
    ['1.234,56', 123456n],
    ['1,234.56', 123456n],
    ['+10', 1000n],
    ['1234.56', 123456n],
    ['1234,56', 123456n],
    // Currency prefixes and stray spaces, in every position banks put them.
    ['R$ 1.234,56', 123456n],
    ['r$ 1.234,56', 123456n],
    ['R$1.234,56', 123456n],
    ['R$ -10.00', -1000n],
    ['-R$ 10.00', -1000n],
    ['- R$ 10.00', -1000n],
    ['R$-10.00', -1000n],
    ['+ R$ 10.00', 1000n],
    ['1 234,56', 123456n],
    ['1\u00a0234,56', 123456n],
    [' 1234,56 ', 123456n],
    ['R$\u00a01.234,56', 123456n],
    ['12 34.56', 123456n],
    ['R$ 1.234,56 ', 123456n],
    // Plain integers and signs.
    ['0', 0n],
    ['007', 700n],
    ['1000', 100000n],
    ['-0,99', -99n],
    ['0,05', 5n],
    // One decimal digit (tenths) — banks truncate trailing zeros.
    ['1234.5', 123450n],
    ['1234,5', 123450n],
    ['-10,5', -1050n],
    // Leading separator: a decimal with no integer part.
    ['.50', 50n],
    [',50', 50n],
    ['-,50', -50n],
    ['.5', 50n],
    // Grouped thousands, both conventions, several groups (signs included).
    ['1.234', 123400n],
    ['1,234', 123400n],
    ['2.500', 250000n],
    ['1.234.567', 123456700n],
    ['-1.234.567', -123456700n],
    ['1,234,567', 123456700n],
    ['-1,234', -123400n],
    ['1.234.567,89', 123456789n],
    ['1,234,567.89', 123456789n],
    ['12.345.678', 1234567800n],
    ['R$ 1.000', 100000n],
    // Trailing separator: treated as integer digits.
    ['1234,', 123400n],
    ['1234.', 123400n],
    ['1.234,', 123400n],
    ['12,34,', 123400n],
    // Mixed with the decimal separator last (the SPEC's ambiguity rule).
    ['0.005', 500n], // 3 digits after a single separator → thousands group
    ['1.005', 100500n],
    ['1,005', 100500n],
    // 4+ digits after a single separator: decimal fraction, rounded half away from zero.
    ['1,2345', 123n],
    ['0,9999', 100n],
    ['0,9994', 100n], // 0.9994 → 99.94 cents → rounds to 100
    ['-0,9995', -100n],
    ['1.999', 199900n], // 3 digits → group (1999 → R$ 1.999,00)
    ['12,345', 1234500n], // 3 digits → group
    // A lone separator in mixed garbage: still deterministic (`,5` after a skipped mark).
    ['.,5', 50n],
    // Repeated same-kind separators: every occurrence is a group mark.
    ['1.234.56', 12345600n],
    ['12.34.567,89', 123456789n],
    // Big values stay exact (no float ever involved).
    ['123456789012345678901.67', 12345678901234567890167n],
    ['1.234.567.890.123.456.789.012,34', 123456789012345678901234n],
    // Sign conventions.
    ['+1234.56', 123456n],
    ['+0', 0n],
    ['-0', 0n],
    ['-0.00', 0n],
  ])('parses %s exactly', (raw, expected) => {
    expect(parseAmountToCents(raw)).toBe(expected);
  });
});

describe('parseAmountToCents — invalid values', () => {
  it.each([
    [''],
    [' '],
    ['R$'],
    ['R$ '],
    ['-'],
    ['+'],
    ['--10'],
    ['10-'],
    ['abc'],
    ['12a.34'],
    ['12.34a'],
    ['1.2.3,4,5'],
    ['1,234.5.6'],
    ['1e3'],
    ['(10.00)'],
    ['1 2 3 a'],
    ['NaN'],
    ['-Infinity'],
    ['.,'],
    ['.'],
    [','],
    ['0x10'],
  ])('rejects %s', (raw) => {
    expect(parseAmountToCents(raw)).toBeUndefined();
  });
});

describe('formatting helpers', () => {
  it('formatMoney renders pt-BR display strings', () => {
    expect(formatMoney({ cents: B(-123456), currency: 'BRL' })).toBe('-R$ 1.234,56');
    expect(formatMoney({ cents: B(0), currency: 'BRL' })).toBe('R$ 0,00');
    expect(formatMoney({ cents: B(5), currency: 'BRL' })).toBe('R$ 0,05');
    expect(formatMoney({ cents: B(100000000), currency: 'BRL' })).toBe('R$ 1.000.000,00');
    expect(formatMoney({ cents: B(123456789), currency: 'BRL' })).toBe('R$ 1.234.567,89');
    expect(formatMoney({ cents: B(123456), currency: 'USD' })).toBe('USD 1.234,56');
    expect(formatMoney({ cents: B(-99), currency: '' })).toBe('-0,99');
    expect(formatMoney({ cents: B(-42), currency: 'XXX' })).toBe('-XXX 0,42');
  });

  it('formatOfxAmount renders the canonical dot form', () => {
    expect(formatOfxAmount({ cents: B(-123456), currency: 'BRL' })).toBe('-1234.56');
    expect(formatOfxAmount({ cents: B(0), currency: 'BRL' })).toBe('0.00');
    expect(formatOfxAmount({ cents: B(5), currency: 'BRL' })).toBe('0.05');
    expect(formatOfxAmount({ cents: 12345678901234567890167n, currency: 'BRL' })).toBe(
      '123456789012345678901.67',
    );
  });

  it('moneyToNumber converts for display (documented lossy beyond 2^53 cents)', () => {
    expect(moneyToNumber({ cents: B(-123456), currency: 'BRL' })).toBe(-1234.56);
    expect(moneyToNumber({ cents: B(0), currency: 'BRL' })).toBe(0);
    expect(moneyToNumber({ cents: B(9), currency: 'BRL' })).toBe(0.09);
  });
});

describe('amount properties (fast-check)', () => {
  const centsArb = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
  const currencyArb = fc.constantFrom('BRL', 'USD', 'EUR', '');
  const moneyArb: fc.Arbitrary<Money> = fc
    .tuple(centsArb, currencyArb)
    .map(([cents, currency]) => ({ cents, currency }));

  it('round-trips through formatMoney (pt-BR, R$, grouping) exactly', () => {
    // formatMoney prefixes non-BRL codes for display (`USD 1.234,56`), which
    // amount parsing intentionally rejects — so the display round trip is a
    // BRL contract; the canonical round trip below covers every currency.
    const brlArb: fc.Arbitrary<Money> = centsArb.map((cents) => ({ cents, currency: 'BRL' }));
    fc.assert(
      fc.property(brlArb, (money) => {
        expect(parseAmountToCents(formatMoney(money))).toBe(money.cents);
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips through formatOfxAmount (canonical dot form) exactly', () => {
    fc.assert(
      fc.property(moneyArb, (money) => {
        expect(parseAmountToCents(formatOfxAmount(money))).toBe(money.cents);
      }),
      { numRuns: 1000 },
    );
  });

  it('stays exact far beyond Number.MAX_SAFE_INTEGER', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (cents) => {
        const money: Money = { cents, currency: 'BRL' };
        expect(parseAmountToCents(formatOfxAmount(money))).toBe(cents);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        expect(() => parseAmountToCents(raw)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });

  it('parses independently built pt-BR / en-US / OFX strings back to the original cents', () => {
    // Formatting is reimplemented here (not via the library formatters), so
    // this is a genuine two-implementation round trip.
    const plainCents = fc.bigInt({ min: -(10n ** 13n), max: 10n ** 13n });
    fc.assert(
      fc.property(plainCents, fc.constantFrom('br', 'en', 'ofx', 'br-r$'), (cents, style) => {
        const negative = cents < 0n;
        const magnitude = negative ? -cents : cents;
        const int = (magnitude / 100n).toString();
        const frac = (magnitude % 100n).toString().padStart(2, '0');
        let grouped = '';
        for (let i = 0; i < int.length; i++) {
          if (i > 0 && (int.length - i) % 3 === 0) {
            grouped += style === 'br' || style === 'br-r$' ? '.' : ',';
          }
          grouped += int.charAt(i);
        }
        const sign = negative ? '-' : '';
        const text =
          style === 'br'
            ? `${sign}${grouped},${frac}`
            : style === 'br-r$'
              ? `R$ ${sign}${grouped},${frac}`
              : style === 'en'
                ? `${sign}${grouped}.${frac}`
                : `${sign}${int}.${frac}`;
        expect(parseAmountToCents(text)).toBe(cents);
      }),
      { numRuns: 1000 },
    );
  });
});
