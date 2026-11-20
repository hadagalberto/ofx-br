/**
 * Money and amount parsing.
 *
 * Brazilian exports format amounts in every convention at once: OFX standard
 * dot decimals (`-1234.56`), pt-BR comma decimals (`-1234,56`), grouped pt-BR
 * (`1.234,56`), grouped en-US (`1,234.56`), bare integers (`+10`) and even
 * values carrying currency symbols and stray spaces (`R$ 1.234,56`). All of
 * them parse here to **exact integer cents** — no float is ever involved.
 *
 * Ambiguity (a lone `1.234`) is resolved per SPEC by the last separator and
 * the digit count:
 *
 * - both separators present → the last one is the decimal separator;
 * - one kind of separator, appearing once:
 *   - nothing before it → decimal (`,50` → 50 cents, `,500` → 0.500 → 50 cents);
 *   - 1–2 digits after → decimal (`1234,5` → 123450, `1234,56` → 123456);
 *   - 3 digits after → thousands group (`1.234` → 123400, `2.500` → 250000);
 *   - 4+ digits after → decimal fraction, rounded half away from zero
 *     (`1,2345` → 1.2345 → 123 cents);
 * - one kind of separator, appearing twice or more → all occurrences are
 *   group separators (`1.234.567` → 123456700).
 *
 * Fractional digits beyond two (never emitted by real banks, tolerated here)
 * round half away from zero.
 */

/** Money as exact integer cents — never floats. */
export interface Money {
  /** Amount in minor units (centavos), exact. */
  cents: bigint;
  /** ISO 4217 code from `CURDEF` (e.g. `'BRL'`); `'XXX'` when absent. */
  currency: string;
}

/** Result of {@linkcode parseAmountToCents}: exact cents, or `undefined` when the value is not an amount. */
export type AmountParseResult = bigint | undefined;

/** Characters stripped from amount values: ASCII whitespace, BOM and the Unicode spaces banks paste in. */
function isAmountNoise(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // LF
    code === 0x0d || // CR
    code === 0x0b || // VT
    code === 0x0c || // FF
    code === 0x00 || // NUL
    code === 0xfeff || // BOM
    code === 0xa0 || // NBSP
    code === 0x2007 || // figure space
    code === 0x2009 || // thin space
    code === 0x202f // narrow NBSP
  );
}

/** True for the characters that may remain after noise/`R$` removal. */
function isAmountChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2e /* . */ ||
    code === 0x2c /* , */
  );
}

/**
 * Removes whitespace and `R$` (any case, anywhere in the value) and applies a
 * single leading sign — before or right after the currency prefix
 * (`-R$ 10`, `R$ -10`, `R$-10`). Returns the digits-and-separators body and
 * the sign, or `undefined` when nothing numeric remains.
 */
function stripAmount(raw: string): { digits: string; negative: boolean } | undefined {
  const length = raw.length;
  let body = '';
  let negative = false;
  let seenSign = false;

  for (let i = 0; i < length; i++) {
    const code = raw.charCodeAt(i);
    if (isAmountNoise(code)) {
      continue;
    }
    if (code === 0x52 /* R */ || code === 0x72 /* r */) {
      if (raw.charCodeAt(i + 1) === 0x24 /* $ */) {
        i++; // skip the '$'
        continue;
      }
      return undefined; // a bare 'R' is not part of any amount
    }
    if (code === 0x2b /* + */ || code === 0x2d /* - */) {
      if (seenSign || body !== '') {
        return undefined; // a second sign, or a sign after digits
      }
      seenSign = true;
      negative = code === 0x2d;
      continue;
    }
    if (!isAmountChar(code)) {
      return undefined; // any other character makes the value unparsable
    }
    body += String.fromCharCode(code);
  }
  if (body === '') {
    return undefined;
  }
  return { digits: body, negative };
}

/**
 * Rounds `totalUnits / 10^scale` (a non-negative digit value) to cents (×100),
 * half up, in exact bigint math. Callers apply the sign.
 */
function scaledToCents(totalUnits: bigint, scale: number): bigint {
  const scaleBase = 10n ** BigInt(scale);
  const scaled = totalUnits * 100n;
  const quotient = scaled / scaleBase;
  const remainder = scaled % scaleBase;
  return remainder * 2n >= scaleBase ? quotient + 1n : quotient;
}

/**
 * Parses an OFX amount to exact integer cents, accepting every format real
 * Brazilian banks emit: `-1234.56`, `-1234,56`, `1.234,56`, `1,234.56`,
 * `+10`, `2.500` (grouped thousands), `R$ 1.234,56`, values with stray or
 * NBSP whitespace. Returns `undefined` when the value is not an amount —
 * the caller reports that as a warning.
 */
export function parseAmountToCents(raw: string): AmountParseResult {
  const stripped = stripAmount(raw);
  if (stripped === undefined) {
    return undefined;
  }
  const digits = stripped.digits;

  let lastSep = -1;
  let lastSepCode = 0;
  let dots = 0;
  let commas = 0;
  let digitCount = 0;
  for (let i = 0; i < digits.length; i++) {
    const code = digits.charCodeAt(i);
    if (code === 0x2e /* . */) {
      dots++;
      lastSep = i;
      lastSepCode = code;
    } else if (code === 0x2c /* , */) {
      commas++;
      lastSep = i;
      lastSepCode = code;
    } else {
      digitCount++;
    }
  }
  if (digitCount === 0) {
    return undefined; // separators without a single digit (``, `,`, `.,`)
  }

  // Plain integer (`10`, `+10`) — by far the most common fast path.
  if (dots === 0 && commas === 0) {
    const cents = BigInt(digits) * 100n;
    return stripped.negative ? -cents : cents;
  }

  const otherSepCode = lastSepCode === 0x2e ? 0x2c : 0x2e;
  const intRaw = digits.slice(0, lastSep);
  const fracRaw = digits.slice(lastSep + 1);

  // Both separator kinds present: the last one is the decimal separator and
  // every occurrence of the other kind in the integer part is a group mark.
  // (At least one digit exists at this point, so the BigInt operand below is
  // never empty.)
  if (dots > 0 && commas > 0) {
    let intDigits = '';
    for (let i = 0; i < intRaw.length; i++) {
      const code = intRaw.charCodeAt(i);
      if (code === otherSepCode) {
        continue;
      }
      if (!isAmountChar(code) || code === lastSepCode) {
        return undefined; // a stray separator of the decimal kind in the integer part
      }
      intDigits += String.fromCharCode(code);
    }
    const total = BigInt((intDigits === '' ? '0' : intDigits) + fracRaw);
    const cents = scaledToCents(total, fracRaw.length);
    return stripped.negative ? -cents : cents;
  }

  // One separator kind. More than one occurrence: all are group separators.
  const occurrences = dots + commas;
  if (occurrences >= 2) {
    let allDigits = '';
    for (let i = 0; i < digits.length; i++) {
      const code = digits.charCodeAt(i);
      if (code !== lastSepCode) {
        allDigits += String.fromCharCode(code);
      }
    }
    const cents = BigInt(allDigits) * 100n;
    return stripped.negative ? -cents : cents;
  }

  // Exactly one separator. Nothing before it: a decimal value (`,50`, `.5`).
  if (intRaw === '') {
    const cents = scaledToCents(BigInt(fracRaw), fracRaw.length);
    return stripped.negative ? -cents : cents;
  }

  // Exactly one separator with an integer part: digit count decides.
  const fracLength = fracRaw.length;
  if (fracLength === 0 || fracLength === 3) {
    // `1234,` or `1.234` / `2.500` — a (possibly trailing) thousands group.
    const cents = BigInt(intRaw + fracRaw) * 100n;
    return stripped.negative ? -cents : cents;
  }
  // 1, 2 or 4+ digits after the separator: a decimal fraction.
  const total = BigInt(intRaw + fracRaw);
  const cents = scaledToCents(total, fracLength);
  return stripped.negative ? -cents : cents;
}

/** Converts money to a plain `number` of major units. Lossy for values beyond ±2^53 cents — display only. */
export function moneyToNumber(money: Money): number {
  return Number(money.cents) / 100;
}

/** Formats money in the canonical OFX form (`-1234.56`) — exact, and parsable back by {@linkcode parseAmountToCents}. */
export function formatOfxAmount(money: Money): string {
  const negative = money.cents < 0n;
  const magnitude = negative ? -money.cents : money.cents;
  const units = magnitude / 100n;
  const cents = magnitude % 100n;
  const text = `${units.toString()}.${cents.toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** Formats money for display, pt-BR style: `R$ 1.234,56`, `-R$ 1.234,56`. */
export function formatMoney(money: Money): string {
  const negative = money.cents < 0n;
  const magnitude = negative ? -money.cents : money.cents;
  const units = (magnitude / 100n).toString();
  let grouped = '';
  for (let i = 0; i < units.length; i++) {
    if (i > 0 && (units.length - i) % 3 === 0) {
      grouped += '.';
    }
    grouped += units.charAt(i);
  }
  const cents = (magnitude % 100n).toString().padStart(2, '0');
  const body = `${grouped},${cents}`;
  const prefix =
    money.currency === 'BRL' ? 'R$ ' : money.currency === '' ? '' : `${money.currency} `;
  return negative ? `-${prefix}${body}` : `${prefix}${body}`;
}
