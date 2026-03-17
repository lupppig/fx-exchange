/**
 * Currency subunit factors.
 * All amounts are stored as integers in their smallest unit.
 * e.g., 1 NGN = 100 kobo, 1 USD = 100 cents, 1 JPY = 1 yen.
 */
const SUBUNIT_FACTORS: Record<string, number> = {
  NGN: 100, // kobo
  USD: 100, // cents
  EUR: 100, // cents
  GBP: 100, // pence
  CAD: 100, // cents
  AUD: 100, // cents
  CHF: 100, // rappen
  JPY: 1,   // yen (no subunit)
  CNY: 100, // fen
  ZAR: 100, // cents
  KES: 100, // cents
  GHS: 100, // pesewas
};

/** Default subunit factor for currencies not in the map */
const DEFAULT_FACTOR = 100;

/**
 * Get the subunit factor for a currency.
 * e.g., getSubunitFactor('NGN') => 100
 */
export function getSubunitFactor(currency: string): number {
  return SUBUNIT_FACTORS[currency.toUpperCase()] ?? DEFAULT_FACTOR;
}

/**
 * Convert a major unit amount to the smallest subunit integer.
 * e.g., toSubunit(10.50, 'NGN') => 1050
 */
export function toSubunit(amount: number, currency: string): number {
  const factor = getSubunitFactor(currency);
  return Math.round(amount * factor);
}

/**
 * Convert a subunit integer back to a major unit amount.
 * e.g., fromSubunit(1050, 'NGN') => 10.50
 */
export function fromSubunit(subunitAmount: number, currency: string): number {
  const factor = getSubunitFactor(currency);
  return subunitAmount / factor;
}
