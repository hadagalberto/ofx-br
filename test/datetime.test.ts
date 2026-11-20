/**
 * OFX date/timezone parsing (SPEC.md "Brazilian specifics — Dates"):
 * `YYYYMMDD`, `YYYYMMDDHHMMSS`, `.XXX` fractions, the `[offset]` suffix
 * forms Brazilian banks emit, the `-03:00` default, invalid dates repaired
 * best-effort (never NaN), plus fast-check round trips for valid dates and
 * totality for arbitrary input.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseOfxDateTime, parseTimeZoneOffset } from '../src/index.js';
import type { OfxDateTimeResult } from '../src/index.js';

const BRT = -3 * 60;

function iso(result: OfxDateTimeResult): string | undefined {
  return result.iso;
}

describe('parseOfxDateTime — valid values', () => {
  type ValidCase = readonly [
    raw: string,
    iso: string,
    offsetMinutes: number | undefined,
    dateOnly: boolean,
  ];

  const VALID_CASES: readonly ValidCase[] = [
    // Date-only values.
    ['20240101', '2024-01-01', undefined, true],
    [' 20240101 ', '2024-01-01', undefined, true],
    ['20240229', '2024-02-29', undefined, true], // leap year
    // Date + time with every timezone suffix form from the SPEC.
    ['20240115120000', '2024-01-15T12:00:00-03:00', BRT, false],
    ['20240115120000[-3:BRT]', '2024-01-15T12:00:00-03:00', BRT, false],
    ['20240115120000[-03:EST]', '2024-01-15T12:00:00-03:00', BRT, false],
    ['20240115120000[0:GMT]', '2024-01-15T12:00:00+00:00', 0, false],
    ['20240115120000[-3]', '2024-01-15T12:00:00-03:00', BRT, false],
    ['20240115120000[+5]', '2024-01-15T12:00:00+05:00', 300, false],
    ['20240115120000[+05:30]', '2024-01-15T12:00:00+05:30', 330, false],
    ['20240115120000[-3:America/Sao_Paulo]', '2024-01-15T12:00:00-03:00', BRT, false],
    ['20240115120000 [ -03:EST ]', '2024-01-15T12:00:00-03:00', BRT, false],
    // 12-digit form (HHMM, seconds default to 00).
    ['202401151200', '2024-01-15T12:00:00-03:00', BRT, false],
    // Fractional seconds.
    ['20240115120000.123', '2024-01-15T12:00:00.123-03:00', BRT, false],
    ['20240115120000.045', '2024-01-15T12:00:00.045-03:00', BRT, false],
    ['20240115120000.005', '2024-01-15T12:00:00.005-03:00', BRT, false],
    ['20240115120000.000', '2024-01-15T12:00:00-03:00', BRT, false],
    ['20240115120000,123', '2024-01-15T12:00:00.123-03:00', BRT, false],
    ['20240115120000.999', '2024-01-15T12:00:00.999-03:00', BRT, false],
    ['20240115120000.000123', '2024-01-15T12:00:00-03:00', BRT, false], // truncated to ms
    ['20240115120000.5', '2024-01-15T12:00:00.500-03:00', BRT, false],
    // Date-only with a timezone suffix: the offset is meaningless and dropped.
    ['20240101[-3:BRT]', '2024-01-01', undefined, true],
  ];

  it.each(VALID_CASES)('parses %s', (raw, iso, offsetMinutes, dateOnly) => {
    const result = parseOfxDateTime(raw);
    expect(result.warnings).toEqual([]);
    expect(result.iso).toBe(iso);
    expect(result.offsetMinutes).toBe(offsetMinutes);
    expect(result.dateOnly).toBe(dateOnly);
  });

  it('applies the configurable default offset when the value has no timezone', () => {
    expect(iso(parseOfxDateTime('20240115120000'))).toBe('2024-01-15T12:00:00-03:00');
    expect(iso(parseOfxDateTime('20240115120000', 0))).toBe('2024-01-15T12:00:00+00:00');
    expect(iso(parseOfxDateTime('20240115120000', 330))).toBe('2024-01-15T12:00:00+05:30');
    expect(parseOfxDateTime('20240115120000', -210).offsetMinutes).toBe(-210);
    // Date-only values never carry an offset, whatever the default is.
    expect(parseOfxDateTime('20240101', 330).dateOnly).toBe(true);
    expect(parseOfxDateTime('20240101', 330).offsetMinutes).toBeUndefined();
  });
});

describe('parseOfxDateTime — invalid values never produce NaN', () => {
  it.each([
    ['20240230', '2024-02-29', 'day 30 clamped to 29'], // Feb 30 → best-effort Feb 29 (2024 is leap)
    ['20230229', '2023-02-28', 'day 29 clamped to 28'], // 2023 is not a leap year
    ['20241301', '2024-12-01', 'month 13 clamped to 12'],
    ['20240015', '2024-01-15', 'month 0 clamped to 1'],
    ['20240132', '2024-01-31', 'day 32 clamped to 31'],
    ['20240115255900', '2024-01-15T23:59:00-03:00', 'hour 25 clamped to 23'],
    ['20240115126000', '2024-01-15T12:59:00-03:00', 'minute 60 clamped to 59'],
    ['20240115120061', '2024-01-15T12:00:59-03:00', 'second 61 clamped to 59'],
    [
      '20241332259961',
      '2024-12-31T23:59:59-03:00',
      'month 13 clamped to 12, day 32 clamped to 31, hour 25 clamped to 23, minute 99 clamped to 59, second 61 clamped to 59',
    ],
  ])('clamps %s best-effort to %s', (raw, expectedIso, expectedDetail) => {
    const result = parseOfxDateTime(raw);
    expect(result.iso).toBe(expectedIso);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('date-clamped');
    expect(result.warnings[0]?.message).toContain(expectedDetail);
  });

  it.each([
    ['', ''],
    ['   ', ''], // whitespace-only: the message quotes the trimmed value ('""')
    ['xyz', 'xyz'],
    ['2024-01-15', '2024-01-15'],
    ['2024115', '2024115'], // 7 digits
    ['202401151', '202401151'], // 9 digits
    ['2024011512', '2024011512'], // 10 digits
    ['20240115120', '20240115120'], // 11 digits
    ['2024011512000', '2024011512000'], // 13 digits
    ['20240115120000.abc', '20240115120000.abc'],
    ['20240115120000.12.3', '20240115120000.12.3'],
    ['20240115.12.00', '20240115.12.00'],
    ['00000000', '00000000'], // year 0000 has no best-effort form
    ['00000001', '00000001'],
  ])('rejects %s with an invalid-date warning', (raw, quoted) => {
    const result = parseOfxDateTime(raw);
    expect(result.iso).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('invalid-date');
    if (quoted !== '') {
      expect(result.warnings[0]?.message).toContain(quoted);
    }
  });

  it('falls back to the default offset for garbage timezone suffixes', () => {
    const result = parseOfxDateTime('20240115120000[WAT]');
    expect(result.iso).toBe('2024-01-15T12:00:00-03:00');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('time-offset-invalid');

    const unterminated = parseOfxDateTime('20240115120000[');
    expect(unterminated.iso).toBe('2024-01-15T12:00:00-03:00');
    expect(unterminated.warnings[0]?.code).toBe('time-offset-invalid');

    expect(parseOfxDateTime('20240115120000[GMT]', 0).offsetMinutes).toBe(0);
  });

  it('clamps out-of-range offsets to ±14:00', () => {
    const result = parseOfxDateTime('20240115120000[-15:XYZ]');
    expect(result.iso).toBe('2024-01-15T12:00:00-14:00');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('time-offset-clamped');

    const positive = parseOfxDateTime('20240115120000[+25]');
    expect(positive.iso).toBe('2024-01-15T12:00:00+14:00');
    expect(positive.warnings[0]?.code).toBe('time-offset-clamped');

    const minutes = parseOfxDateTime('20240115120000[-3:99]');
    expect(minutes.iso).toBe('2024-01-15T12:00:00-03:59');
    expect(minutes.warnings[0]?.code).toBe('time-offset-clamped');
  });

  it('reads the numeric prefix of a malformed offset and ignores the rest', () => {
    // `[-123:EST]`: the hour field stops after two digits; the surplus digit
    // and the name are ignored — the numeric prefix wins, deterministically.
    const result = parseOfxDateTime('20240115120000[-123:EST]');
    expect(result.iso).toBe('2024-01-15T12:00:00-12:00');
    expect(result.warnings).toEqual([]);
  });
});

describe('parseTimeZoneOffset', () => {
  it.each([
    ['-03:00', -180],
    ['-3', -180],
    ['-03', -180],
    ['3', 180],
    ['+3', 180],
    ['0', 0],
    ['+05:30', 330],
    ['-03:30', -210],
    ['-14:00', -840],
    ['14:00', 840],
    [' -03:00 ', -180],
  ])('parses %s', (raw, expected) => {
    expect(parseTimeZoneOffset(raw)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'abc',
    '12:345',
    '05:3',
    '-15:00',
    '+99',
    '15',
    '3:',
    '+3:0',
    '1:234',
    '0x3',
    '100',
  ])('rejects %s', (raw) => {
    expect(parseTimeZoneOffset(raw)).toBeUndefined();
  });
});

describe('datetime properties (fast-check)', () => {
  const yearArb = fc.integer({ min: 1, max: 9999 });
  const monthArb = fc.integer({ min: 1, max: 12 });
  const dayOfTimeArb = fc.integer({ min: 0, max: 23 });
  const minuteArb = fc.integer({ min: 0, max: 59 });
  const secondArb = fc.integer({ min: 0, max: 59 });
  const offsetHoursArb = fc.integer({ min: -14, max: 14 });

  function daysIn(year: number, month: number): number {
    if (month === 2) {
      return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  const pad = (n: number): string => String(n).padStart(2, '0');

  const dateArb = yearArb.chain((year) =>
    monthArb.chain((month) =>
      fc.integer({ min: 1, max: daysIn(year, month) }).map((day) => ({ year, month, day })),
    ),
  );

  it('round-trips valid datetimes through the OFX form exactly, with zero warnings', () => {
    fc.assert(
      fc.property(
        dateArb,
        dayOfTimeArb,
        minuteArb,
        secondArb,
        fc.option(offsetHoursArb, { nil: undefined }),
        fc.constantFrom(false, true),
        (date, hour, minute, second, offsetHours, withMs) => {
          const { year, month, day } = date;
          const digits = `${String(year).padStart(4, '0')}${pad(month)}${pad(day)}${pad(hour)}${pad(minute)}${pad(second)}`;
          const fraction = withMs ? '.137' : '';
          const offset =
            offsetHours === undefined
              ? ''
              : `[${offsetHours < 0 ? '-' : '+'}${pad(Math.abs(offsetHours))}:BRT]`;
          const raw = `${digits}${fraction}${offset}`;
          const result = parseOfxDateTime(raw, -180);
          expect(result.warnings).toEqual([]);
          const sign = offsetHours ?? -3;
          const expectedOffset = sign < 0 ? '-' : '+';
          expect(result.iso).toBe(
            `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${withMs ? '.137' : ''}${expectedOffset}${pad(Math.abs(sign))}:00`,
          );
          expect(result.offsetMinutes).toBe(sign * 60);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('round-trips valid date-only values', () => {
    fc.assert(
      fc.property(dateArb, (date) => {
        const { year, month, day } = date;
        const result = parseOfxDateTime(`${String(year).padStart(4, '0')}${pad(month)}${pad(day)}`);
        expect(result.warnings).toEqual([]);
        expect(result.dateOnly).toBe(true);
        expect(result.iso).toBe(`${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        expect(() => parseOfxDateTime(raw)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });

  it('never returns an out-of-range ISO field on arbitrary digit strings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 16 }),
        (digits) => {
          const raw = digits.join('');
          const result = parseOfxDateTime(raw);
          const match =
            /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(
              result.iso ?? '',
            );
          if (result.iso !== undefined) {
            expect(match).not.toBeNull();
          }
          if (match !== null) {
            const [, y, mo, d, h, mi, s] = match;
            expect(Number(mo)).toBeGreaterThanOrEqual(1);
            expect(Number(mo)).toBeLessThanOrEqual(12);
            expect(Number(d)).toBeGreaterThanOrEqual(1);
            expect(Number(d)).toBeLessThanOrEqual(daysIn(Number(y), Number(mo)));
            if (h !== undefined && mi !== undefined && s !== undefined) {
              expect(Number(h)).toBeLessThanOrEqual(23);
              expect(Number(mi)).toBeLessThanOrEqual(59);
              expect(Number(s)).toBeLessThanOrEqual(59);
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
