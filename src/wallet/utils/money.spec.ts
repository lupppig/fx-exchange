import { Decimal } from 'decimal.js';
import {
  toSubunits,
  fromSubunits,
  crossRate,
  convertSubunits,
  applySpread,
  parseRate,
} from './money';

describe('money', () => {
  describe('toSubunits / fromSubunits', () => {
    it('round-trips whole units', () => {
      const sub = toSubunits('10.50', 'USD');
      expect(sub).toBe(1050n);
      expect(fromSubunits(sub, 'USD').toString()).toBe('10.5');
    });

    it('floors fractional subunits (no silent rounding up)', () => {
      // 10.5099 USD = 1050.99 cents -> floor -> 1050 cents
      expect(toSubunits('10.5099', 'USD')).toBe(1050n);
    });

    it('treats JPY as zero-subunit currency', () => {
      // 1500.99 JPY -> 1500 (factor = 1)
      expect(toSubunits('1500.99', 'JPY')).toBe(1500n);
      expect(fromSubunits(1500n, 'JPY').toString()).toBe('1500');
    });

    it('handles very large balances beyond 2^53', () => {
      // 1e16 cents = $100 trillion -- beyond Number.MAX_SAFE_INTEGER (~9e15)
      const huge = toSubunits('100000000000000', 'USD');
      expect(huge).toBe(10000000000000000n);
      // Convert back -- should still be exact
      expect(fromSubunits(huge, 'USD').toString()).toBe('100000000000000');
    });
  });

  describe('crossRate', () => {
    it('computes BASE->X / BASE->Y as Y/X', () => {
      // base = NGN, USD/NGN = 0.00065, EUR/NGN = 0.00060
      // rate(USD->EUR) = 0.00060 / 0.00065 = 0.923076923...
      const r = crossRate('0.00065', '0.00060');
      expect(r.toFixed(6)).toBe('0.923077');
    });

    it('rate(X->X) is 1', () => {
      expect(crossRate('0.00065', '0.00065').toString()).toBe('1');
    });
  });

  describe('convertSubunits', () => {
    it('preserves value through a round-trip at a 1:1 rate', () => {
      // 5000 cents USD * 1.0 (USD->USD) = 5000 cents USD
      expect(convertSubunits(5000n, 'USD', 'USD', 1)).toBe(5000n);
    });

    it('rejects sub-subunit conversions by returning 0', () => {
      // 1 kobo NGN at 0.00065 USD per NGN = 0.000065 USD = 0.0065 cents -> 0
      expect(convertSubunits(1n, 'NGN', 'USD', '0.00065')).toBe(0n);
    });

    it('preserves precision on cross-currency low-value pairs', () => {
      // 1 USD = 100 cents, rate USD->NGN = 1538.46153846
      // 100 cents -> 1 USD -> 1538.46153846 NGN -> 153846.15... kobo -> floor -> 153846
      expect(convertSubunits(100n, 'USD', 'NGN', '1538.46153846')).toBe(
        153846n,
      );
    });

    it('does not drift on repeated small conversions', () => {
      // 1000 conversions of 100 USD cents at a 1.5 rate should be exactly
      // floor(1 * 1.5) * 100 = 150 cents each, totalling 150_000.
      let total = 0n;
      for (let i = 0; i < 1000; i++) {
        total += convertSubunits(100n, 'USD', 'EUR', '1.5');
      }
      expect(total).toBe(150_000n);
    });
  });

  describe('applySpread', () => {
    it('puts bid below mid and ask above mid', () => {
      const { bid, ask } = applySpread('100', 50); // 50 bps = 0.5%
      // half-spread = 0.0025 -> bid = 99.75, ask = 100.25
      expect(bid.toFixed(4)).toBe('99.7500');
      expect(ask.toFixed(4)).toBe('100.2500');
    });

    it('zero spread collapses bid=ask=mid', () => {
      const { bid, ask } = applySpread('42.42', 0);
      expect(bid.toString()).toBe('42.42');
      expect(ask.toString()).toBe('42.42');
    });

    it('total spread equals supplied bps', () => {
      const mid = new Decimal('1538.461538');
      const { bid, ask } = applySpread(mid, 100); // 100 bps
      const spreadPct = ask.minus(bid).div(mid).times(10000);
      expect(spreadPct.toFixed(0)).toBe('100');
    });
  });

  describe('parseRate', () => {
    it('throws on null/undefined/zero/negative/NaN', () => {
      expect(() => parseRate(null)).toThrow();
      expect(() => parseRate(undefined)).toThrow();
      expect(() => parseRate(0)).toThrow();
      expect(() => parseRate(-1)).toThrow();
      expect(() => parseRate('not a number')).toThrow();
    });

    it('accepts string and number rates', () => {
      expect(parseRate('1.234').toString()).toBe('1.234');
      expect(parseRate(1.234).toString()).toBe('1.234');
    });
  });
});
