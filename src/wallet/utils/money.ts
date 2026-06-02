import { Decimal } from 'decimal.js';
import { getSubunitFactor } from './currency.util';

/**
 * Precision configuration for Decimal.js inside the FX engine.
 *
 * 40 significant digits is well beyond any realistic FX rate / balance combination
 * (a balance of 10^15 subunits multiplied by a 10-decimal rate has at most ~25 digits)
 * and gives us a comfortable safety margin against intermediate-step rounding.
 *
 * ROUND_HALF_EVEN (banker's rounding) is the standard for monetary math: it removes
 * the systematic bias of HALF_UP and matches IEEE 754's default mode.
 */
Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export type DecimalLike = Decimal | string | number | bigint;

/**
 * Convert a major-unit Decimal amount to its smallest-subunit integer,
 * rounding down to avoid ever crediting more than the user is owed.
 *
 * Example: subunits(10.5005, 'USD') -> 1050 cents (not 1051).
 *
 * Floor-rounding here is deliberate: in FX conversion the user receives
 * `floor(amountIn * rate)`; the fractional residue belongs to the house
 * and shows up as the spread / rounding revenue line, never as silently
 * lost money.
 */
export function toSubunits(major: DecimalLike, currency: string): bigint {
  const factor = getSubunitFactor(currency);
  const subunit = new Decimal(major as Decimal.Value).times(factor);
  // Decimal -> bigint via toFixed(0) avoids the Number() round-trip and its 2^53 ceiling
  return BigInt(subunit.floor().toFixed(0));
}

/**
 * Convert a subunit integer (bigint or number) back into a major-unit Decimal.
 * Pure division, no rounding.
 */
export function fromSubunits(sub: bigint | number, currency: string): Decimal {
  const factor = getSubunitFactor(currency);
  return new Decimal(sub.toString()).div(factor);
}

/**
 * Cross rate from two NGN-base rates.
 *
 * The upstream FX provider gives us rates with NGN as the base currency
 * (`rates[X] = how many X per 1 NGN`). To convert from currency A to B we need
 *
 *     rate(A->B) = (X per 1 NGN for B) / (X per 1 NGN for A)
 *
 * Done with arbitrary-precision Decimal so a 10-decimal rate like
 * 0.0000123456 keeps every meaningful digit instead of being squashed
 * through IEEE 754.
 */
export function crossRate(
  fromRateVsBase: DecimalLike,
  toRateVsBase: DecimalLike,
): Decimal {
  return new Decimal(toRateVsBase as Decimal.Value).div(
    fromRateVsBase as Decimal.Value,
  );
}

/**
 * Convert an integer subunit `amountIn` of `fromCurrency` into the integer
 * subunit value of `toCurrency`, using the supplied mid/effective rate
 * (already in major-unit terms, i.e. `1 from = rate to`).
 *
 * The math is done end-to-end in Decimal then floored back to a subunit
 * integer. Returns `0n` if the trade is too small to credit a whole
 * subunit -- callers should reject that case rather than book a zero-value
 * journal entry.
 */
export function convertSubunits(
  amountInSubunits: bigint,
  fromCurrency: string,
  toCurrency: string,
  rate: DecimalLike,
): bigint {
  const major = fromSubunits(amountInSubunits, fromCurrency);
  const converted = major.times(rate as Decimal.Value);
  return toSubunits(converted, toCurrency);
}

/**
 * Apply a spread (in basis points) around a mid rate, returning {bid, ask}.
 *
 *   bid = the rate at which the house BUYS the base currency from the user
 *         (i.e. the rate the user gets when selling base for quote)
 *   ask = the rate at which the house SELLS the base currency to the user
 *         (i.e. the rate the user gets when buying base with quote)
 *
 * 100 bps = 1.00%. Default for retail FX is ~50 bps total spread.
 */
export function applySpread(
  midRate: DecimalLike,
  spreadBps: number,
): { bid: Decimal; ask: Decimal } {
  const mid = new Decimal(midRate as Decimal.Value);
  const halfSpread = new Decimal(spreadBps).div(10000).div(2);
  return {
    bid: mid.times(new Decimal(1).minus(halfSpread)),
    ask: mid.times(new Decimal(1).plus(halfSpread)),
  };
}

/** Parse a string/number rate from the FX provider into a Decimal, throwing on garbage. */
export function parseRate(value: unknown): Decimal {
  if (value === null || value === undefined) {
    throw new Error('FX rate is null or undefined');
  }
  const d = new Decimal(value as Decimal.Value);
  if (!d.isFinite() || d.lte(0)) {
    throw new Error(`FX rate is not a positive finite number: ${String(value)}`);
  }
  return d;
}
