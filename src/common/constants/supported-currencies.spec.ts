import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  IsSupportedCurrencyConstraint,
} from './supported-currencies';

describe('Supported Currencies', () => {
  describe('SUPPORTED_CURRENCIES', () => {
    it('should contain expected currencies', () => {
      expect(SUPPORTED_CURRENCIES).toContain('NGN');
      expect(SUPPORTED_CURRENCIES).toContain('USD');
      expect(SUPPORTED_CURRENCIES).toContain('EUR');
      expect(SUPPORTED_CURRENCIES).toContain('JPY');
    });

    it('should all be 3-letter uppercase strings', () => {
      for (const c of SUPPORTED_CURRENCIES) {
        expect(c).toMatch(/^[A-Z]{3}$/);
      }
    });
  });

  describe('isSupportedCurrency()', () => {
    it('should return true for valid currencies', () => {
      expect(isSupportedCurrency('NGN')).toBe(true);
      expect(isSupportedCurrency('usd')).toBe(true); // case-insensitive
      expect(isSupportedCurrency('Eur')).toBe(true);
    });

    it('should return false for invalid currencies', () => {
      expect(isSupportedCurrency('XYZ')).toBe(false);
      expect(isSupportedCurrency('BTC')).toBe(false);
      expect(isSupportedCurrency('')).toBe(false);
    });

    it('should handle null/undefined gracefully', () => {
      expect(isSupportedCurrency(null as any)).toBe(false);
      expect(isSupportedCurrency(undefined as any)).toBe(false);
    });
  });

  describe('IsSupportedCurrencyConstraint', () => {
    const constraint = new IsSupportedCurrencyConstraint();

    it('should validate supported currency strings', () => {
      expect(constraint.validate('NGN')).toBe(true);
      expect(constraint.validate('USD')).toBe(true);
    });

    it('should reject non-supported currencies', () => {
      expect(constraint.validate('BTC')).toBe(false);
      expect(constraint.validate('XYZ')).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(constraint.validate(123)).toBe(false);
      expect(constraint.validate(null)).toBe(false);
      expect(constraint.validate(undefined)).toBe(false);
    });

    it('should return an informative default message', () => {
      const msg = constraint.defaultMessage();
      expect(msg).toContain('NGN');
      expect(msg).toContain('USD');
    });
  });
});
