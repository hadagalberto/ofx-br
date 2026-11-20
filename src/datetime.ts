/**
 * OFX date and timezone parsing.
 *
 * OFX dates are `YYYYMMDD`, `YYYYMMDDHHMMSS` or `YYYYMMDDHHMMSS.XXX`, with an
 * optional GMT-offset suffix: `[-3:BRT]`, `[-03:EST]`, `[0:GMT]`, `[-3]` —
 * or, in the exports real banks ship, none of those exactly. This module:
 *
 * - emits **ISO 8601** — `YYYY-MM-DD` for date-only values,
 *   `YYYY-MM-DDTHH:MM:SS[.fff]±HH:MM` when a time is present (offset 0 is
 *   `+00:00`);
 * - defaults a missing timezone to `-03:00` (BRT, per SPEC — Brazil has had
 *   no DST since 2019), configurable via the `tz` option
 *   ({@linkcode parseTimeZoneOffset});
 * - keeps the numeric offset authoritative and ignores the tz *name*;
 * - never yields `NaN`: out-of-range fields are clamped with a `date-clamped`
 *   warning (`20240230` → best-effort `2024-02-29`), and values that are not
 *   OFX dates at all produce no ISO string and an `invalid-date` warning.
 *
 * Fractions beyond three digits (never emitted by real banks) are truncated
 * to milliseconds.
 */
import type { ParseWarning } from './types.js';

/** Warning codes emitted by this module (no location; the mapper attaches one). */
export type OfxDateWarningCode =
  'invalid-date' | 'date-clamped' | 'time-offset-invalid' | 'time-offset-clamped';

/** A datetime warning with its stable code narrowed for relaying. */
export interface OfxDateWarning extends ParseWarning {
  code: OfxDateWarningCode;
}

/** Result of {@linkcode parseOfxDateTime}. */
export interface OfxDateTimeResult {
  /** ISO 8601 value, or `undefined` when the raw value is not an OFX date. */
  iso?: string;
  /** Offset in minutes east of UTC, present whenever a time was parsed. */
  offsetMinutes?: number;
  /** True when the value carried no time part (`YYYYMMDD`). */
  dateOnly: boolean;
  /** Problems found (stable codes, no location). */
  warnings: OfxDateWarning[];
}

/** Maximum absolute timezone offset, in minutes (UTC-14 .. UTC+14). */
const MAX_OFFSET_MINUTES = 14 * 60;

/** Digit-body lengths accepted: `YYYYMMDD`, `YYYYMMDDHHMM`, `YYYYMMDDHHMMSS`. */
const DATE_DIGIT_LENGTHS: ReadonlySet<number> = new Set([8, 12, 14]);

function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function digitsToNumber(text: string, from: number, length: number): number {
  let value = 0;
  for (let i = from; i < from + length; i++) {
    value = value * 10 + (text.charCodeAt(i) - 0x30);
  }
  return value;
}

/** Days in `month` of `year` (proleptic Gregorian, year 1..9999). */
function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function pad3(value: number): string {
  return value < 10 ? `00${value}` : value < 100 ? `0${value}` : String(value);
}

/**
 * Converts fractional-hour digits (the `5` in `+5.5`) to whole minutes,
 * rounding half up in integer math. `5` → 30, `75` → 45, `25` → 15.
 */
function fractionHoursToMinutes(fractionDigits: string): number {
  let numerator = 0;
  for (let i = 0; i < fractionDigits.length; i++) {
    numerator = numerator * 10 + (fractionDigits.charCodeAt(i) - 0x30);
  }
  const denominator = 10 ** fractionDigits.length;
  return Math.floor((2 * numerator * 60 + denominator) / (2 * denominator));
}

/**
 * Parses a timezone offset option: `'-03:00'`, `'-3'`, `'3'`, `'+05:30'`.
 * Returns minutes east of UTC, or `undefined` when the value is not a valid
 * offset (the caller falls back to the SPEC default and warns).
 */
export function parseTimeZoneOffset(raw: string): number | undefined {
  const trimmed = raw.trim();
  let negative = false;
  let pos = 0;
  const head = trimmed.charCodeAt(pos);
  if (head === 0x2d /* - */ || head === 0x2b /* + */) {
    negative = head === 0x2d;
    pos++;
  }
  let hours = 0;
  let hourDigits = 0;
  while (pos < trimmed.length && isDigitCode(trimmed.charCodeAt(pos))) {
    if (hourDigits === 2) {
      return undefined; // more than two hour digits
    }
    hours = hours * 10 + (trimmed.charCodeAt(pos) - 0x30);
    hourDigits++;
    pos++;
  }
  if (hourDigits === 0) {
    return undefined;
  }
  let minutes = 0;
  // Decimal hours: `+5.5` = +05:30, `-3.5` = -03:30, `+5.75` = +05:45.
  if (trimmed.charCodeAt(pos) === 0x2e /* . */ && isDigitCode(trimmed.charCodeAt(pos + 1))) {
    let end = pos + 1;
    while (end < trimmed.length && isDigitCode(trimmed.charCodeAt(end))) {
      end++;
    }
    minutes = fractionHoursToMinutes(trimmed.slice(pos + 1, end));
    pos = end;
  }
  if (trimmed.charCodeAt(pos) === 0x3a /* : */) {
    pos++;
    let minuteDigits = 0;
    while (pos < trimmed.length && isDigitCode(trimmed.charCodeAt(pos))) {
      if (minuteDigits === 2) {
        return undefined;
      }
      minutes = minutes * 10 + (trimmed.charCodeAt(pos) - 0x30);
      minuteDigits++;
      pos++;
    }
    if (minuteDigits !== 2) {
      return undefined;
    }
  }
  if (pos !== trimmed.length) {
    return undefined; // trailing garbage
  }
  const total = hours * 60 + minutes;
  if (total > MAX_OFFSET_MINUTES) {
    return undefined; // out of range: let the caller warn and fall back
  }
  return negative ? -total : total;
}

interface ClampedField {
  readonly name: string;
  readonly raw: number;
  readonly clamped: number;
}

/** Clamps `value` into `min..max`, recording the repair. */
function clampField(
  fields: ClampedField[],
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (value < min) {
    fields.push({ name, raw: value, clamped: min });
    return min;
  }
  if (value > max) {
    fields.push({ name, raw: value, clamped: max });
    return max;
  }
  return value;
}

/** Extracts and validates the digit part of an OFX date. */
interface DateFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  hasTime: boolean;
  clamped: ClampedField[];
}

/** Splits and clamps the 8/12/14-digit body; `undefined` when the body is not acceptable. */
function readDateFields(digits: string, millisecond: number): DateFields | undefined {
  const year = digitsToNumber(digits, 0, 4);
  if (year === 0) {
    return undefined; // year 0000 has no best-effort interpretation
  }
  const clamped: ClampedField[] = [];
  const month = clampField(clamped, 'month', digitsToNumber(digits, 4, 2), 1, 12);
  const day = clampField(clamped, 'day', digitsToNumber(digits, 6, 2), 1, daysInMonth(year, month));
  const hasTime = digits.length >= 12;
  const hour = hasTime ? clampField(clamped, 'hour', digitsToNumber(digits, 8, 2), 0, 23) : 0;
  const minute = hasTime ? clampField(clamped, 'minute', digitsToNumber(digits, 10, 2), 0, 59) : 0;
  const second =
    digits.length >= 14 ? clampField(clamped, 'second', digitsToNumber(digits, 12, 2), 0, 59) : 0;
  return { year, month, day, hour, minute, second, millisecond, hasTime, clamped };
}

/**
 * Parses the content of a `[...]` timezone suffix: `[-3:BRT]`, `[-03:EST]`,
 * `[0:GMT]`, `[-3]`, `[+5:45]`. The tz *name*, when present, is ignored (the
 * numeric offset is authoritative; Brazilian banks emit names like `BRT`).
 * Out-of-range offsets clamp to ±14:00 with a warning; garbage falls back to
 * `defaultOffsetMinutes` with a warning.
 */
function parseOffsetSuffix(
  raw: string | undefined,
  defaultOffsetMinutes: number,
): {
  offsetMinutes: number;
  warnings: OfxDateWarning[];
} {
  if (raw === undefined) {
    return { offsetMinutes: defaultOffsetMinutes, warnings: [] };
  }
  const trimmed = raw.trim();
  let negative = false;
  let pos = 0;
  const head = trimmed.charCodeAt(pos);
  if (head === 0x2d /* - */ || head === 0x2b /* + */) {
    negative = head === 0x2d;
    pos++;
  }
  let hours = 0;
  let hourDigits = 0;
  while (pos < trimmed.length && isDigitCode(trimmed.charCodeAt(pos))) {
    if (hourDigits === 2) {
      break;
    }
    hours = hours * 10 + (trimmed.charCodeAt(pos) - 0x30);
    hourDigits++;
    pos++;
  }
  if (hourDigits === 0) {
    return {
      offsetMinutes: defaultOffsetMinutes,
      warnings: [
        {
          code: 'time-offset-invalid',
          message: `Timezone ${JSON.stringify(trimmed)} could not be interpreted; the default offset was used instead`,
        },
      ],
    };
  }
  let minutes = 0;
  let clampedTo: number | undefined;
  // Decimal hours: `[+5.5:IST]` = +05:30, `[-3.5]` = -03:30. An explicit
  // numeric field after ':' still wins over the fractional part.
  if (trimmed.charCodeAt(pos) === 0x2e /* . */ && isDigitCode(trimmed.charCodeAt(pos + 1))) {
    let end = pos + 1;
    while (end < trimmed.length && isDigitCode(trimmed.charCodeAt(end))) {
      end++;
    }
    minutes = fractionHoursToMinutes(trimmed.slice(pos + 1, end));
    pos = end;
  }
  if (trimmed.charCodeAt(pos) === 0x3a /* : */) {
    const after = trimmed.charCodeAt(pos + 1);
    if (isDigitCode(after)) {
      // `[-3:30]` — minutes; anything else is a tz name and is ignored.
      minutes = digitsToNumber(trimmed, pos + 1, 2);
      if (minutes > 59) {
        minutes = 59;
        clampedTo = 59;
      }
    }
    // `[-3:BRT]`, `[0:GMT]`, `[-03:America/Sao_Paulo]`: name after the colon — ignored.
  }
  let total = hours * 60 + minutes;
  if (total > MAX_OFFSET_MINUTES) {
    total = MAX_OFFSET_MINUTES;
    clampedTo = MAX_OFFSET_MINUTES;
  }
  const warnings: OfxDateWarning[] =
    clampedTo === undefined
      ? []
      : [
          {
            code: 'time-offset-clamped',
            message: `Timezone ${JSON.stringify(trimmed)} is out of range; the offset was clamped to ±${MAX_OFFSET_MINUTES / 60}:00`,
          },
        ];
  return { offsetMinutes: negative ? -total : total, warnings };
}

function offsetToIso(minutes: number): string {
  const negative = minutes < 0;
  const magnitude = negative ? -minutes : minutes;
  return `${negative ? '-' : '+'}${pad2(Math.floor(magnitude / 60))}:${pad2(magnitude % 60)}`;
}

/**
 * Parses an OFX date/time value into ISO 8601.
 *
 * `defaultOffsetMinutes` (default `-03:00`) is applied when the value carries
 * a time but no timezone suffix. Best-effort: out-of-range fields clamp with
 * a warning, hopeless values return no ISO string.
 */
export function parseOfxDateTime(raw: string, defaultOffsetMinutes = -3 * 60): OfxDateTimeResult {
  const trimmed = raw.trim();
  const warnings: OfxDateWarning[] = [];

  let datePart = trimmed;
  let tzPart: string | undefined;
  const bracket = trimmed.indexOf('[');
  if (bracket >= 0) {
    datePart = trimmed.slice(0, bracket).trim();
    const rest = trimmed.slice(bracket + 1);
    const close = rest.indexOf(']');
    tzPart = close >= 0 ? rest.slice(0, close) : rest;
  }

  // Digit body with an optional fraction: `20240115`, `20240115120000.123`.
  const dot = datePart.search(/[.,]/);
  const digitBody = dot === -1 ? datePart : datePart.slice(0, dot);
  const fraction = dot === -1 ? '' : datePart.slice(dot + 1);
  if (
    digitBody.length === 0 ||
    !DATE_DIGIT_LENGTHS.has(digitBody.length) ||
    (fraction !== '' && !/^\d+$/.test(fraction))
  ) {
    warnings.push({
      code: 'invalid-date',
      message: `Date value ${JSON.stringify(trimmed)} is not a valid OFX date; it was ignored`,
    });
    return { dateOnly: false, warnings };
  }

  // Fraction: truncate to milliseconds (real banks emit exactly .XXX).
  const millisecond =
    fraction === '' ? 0 : Math.min(999, Number.parseInt(fraction.slice(0, 3).padEnd(3, '0'), 10));

  const fields = readDateFields(digitBody, millisecond);
  if (fields === undefined) {
    warnings.push({
      code: 'invalid-date',
      message: `Date value ${JSON.stringify(trimmed)} is not a valid OFX date; it was ignored`,
    });
    return { dateOnly: false, warnings };
  }

  if (fields.clamped.length > 0) {
    const detail = fields.clamped
      .map((entry) => `${entry.name} ${entry.raw} clamped to ${entry.clamped}`)
      .join(', ');
    warnings.push({
      code: 'date-clamped',
      message: `Invalid field(s) in date ${JSON.stringify(trimmed)}: ${detail}`,
    });
  }

  const dateIso = `${String(fields.year).padStart(4, '0')}-${pad2(fields.month)}-${pad2(fields.day)}`;
  if (!fields.hasTime) {
    // Date-only: the offset is meaningless and is not emitted.
    return { iso: dateIso, dateOnly: true, warnings };
  }

  const offset = parseOffsetSuffix(tzPart, defaultOffsetMinutes);
  warnings.push(...offset.warnings);
  const time =
    `${pad2(fields.hour)}:${pad2(fields.minute)}:${pad2(fields.second)}` +
    (fields.millisecond > 0 ? `.${pad3(fields.millisecond)}` : '');
  return {
    iso: `${dateIso}T${time}${offsetToIso(offset.offsetMinutes)}`,
    offsetMinutes: offset.offsetMinutes,
    dateOnly: false,
    warnings,
  };
}
