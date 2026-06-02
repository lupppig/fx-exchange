import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { QuoteService } from './quote.service';
import { FxService } from './fx.service';

describe('QuoteService', () => {
  let service: QuoteService;
  let redis: { set: jest.Mock; get: jest.Mock; del: jest.Mock; getdel: jest.Mock };
  let fx: { getRates: jest.Mock };
  let storedQuote: string | undefined;

  beforeEach(async () => {
    storedQuote = undefined;

    redis = {
      set: jest.fn().mockImplementation(async (_k, v) => {
        storedQuote = v as string;
        return 'OK';
      }),
      get: jest.fn().mockImplementation(async () => storedQuote ?? null),
      del: jest.fn().mockImplementation(async () => {
        storedQuote = undefined;
        return 1;
      }),
      getdel: jest.fn().mockImplementation(async () => {
        const v = storedQuote ?? null;
        storedQuote = undefined;
        return v;
      }),
    };

    fx = {
      // NGN=1, USD=0.00065 means 1 NGN = 0.00065 USD, i.e. 1 USD ~= 1538 NGN
      getRates: jest.fn().mockResolvedValue({
        version: 'rate-v1',
        base: 'NGN',
        timestamp: new Date().toISOString(),
        rates: { NGN: 1, USD: 0.00065, EUR: 0.0006 },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuoteService,
        { provide: FxService, useValue: fx },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, dflt: unknown) => {
              if (key === 'FX_SPREAD_BPS') return 50;
              if (key === 'FX_QUOTE_TTL_SECONDS') return 10;
              return dflt;
            }),
          },
        },
        { provide: 'default_IORedisModuleConnectionToken', useValue: redis },
      ],
    }).compile();

    service = module.get(QuoteService);
  });

  it('issues a quote with bid < mid < ask and a future expiry', async () => {
    const q = await service.createQuote({
      userId: 'u1',
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      amountInSubunits: 1_000_000n, // 10,000 NGN
    });

    expect(q.id).toBeTruthy();
    expect(Number(q.bid)).toBeLessThan(Number(q.midRate));
    expect(Number(q.ask)).toBeGreaterThan(Number(q.midRate));
    // SELL of NGN takes the BID side -- effective = bid.
    expect(q.effectiveRate).toBe(q.bid);
    expect(new Date(q.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(q.rateVersion).toBe('rate-v1');
    // Quote payload was persisted.
    expect(redis.set).toHaveBeenCalledWith(
      `fx:quote:${q.id}`,
      expect.any(String),
      'EX',
      10,
    );
  });

  it('amountOut equals amountIn * effectiveRate, floored, at the bid', async () => {
    const q = await service.createQuote({
      userId: 'u1',
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      amountInSubunits: 100_000_000n, // 1,000,000 NGN
    });
    // amountIn (major) = 1_000_000 NGN
    // mid rate USD/NGN = 0.00065
    // half spread = 0.0025 -> bid = mid * (1 - 0.0025) = 0.00064837500
    // amountOut major = 1_000_000 * 0.000648375 = 648.375 USD
    // amountOut subunits = floor(648.375 * 100) = 64837 cents
    expect(q.amountOutSubunits).toBe('64837');
  });

  it('rejects same-currency, unsupported, and non-positive amounts', async () => {
    await expect(
      service.createQuote({
        userId: 'u1',
        fromCurrency: 'USD',
        toCurrency: 'USD',
        amountInSubunits: 100n,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createQuote({
        userId: 'u1',
        fromCurrency: 'XXX',
        toCurrency: 'USD',
        amountInSubunits: 100n,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createQuote({
        userId: 'u1',
        fromCurrency: 'NGN',
        toCurrency: 'USD',
        amountInSubunits: 0n,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects amounts so small they yield zero subunits after spread', async () => {
    // 1 kobo NGN -> 0.00065 * 1 NGN * (cents factor 100) ≈ 0.0065 cents -> 0
    await expect(
      service.createQuote({
        userId: 'u1',
        fromCurrency: 'NGN',
        toCurrency: 'USD',
        amountInSubunits: 1n,
      }),
    ).rejects.toThrow(/too small/i);
  });

  it('consumeQuote: redeems exactly once', async () => {
    const q = await service.createQuote({
      userId: 'u1',
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      amountInSubunits: 1_000_000n,
    });

    const first = await service.consumeQuote(q.id, 'u1');
    expect(first?.id).toBe(q.id);

    const second = await service.consumeQuote(q.id, 'u1');
    expect(second).toBeNull();
  });

  it('consumeQuote: rejects wrong user without leaking the quote', async () => {
    const q = await service.createQuote({
      userId: 'u1',
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      amountInSubunits: 1_000_000n,
    });

    const stolen = await service.consumeQuote(q.id, 'u2');
    expect(stolen).toBeNull();

    // GETDEL already burned the key -- second call by the legit user
    // also returns null. This is the right behavior: a hostile lookup
    // permanently invalidates the quote, which is a small but real
    // DOS surface. Document, accept, and move on -- real-world quotes
    // are short-lived and re-requested cheaply.
    const legit = await service.consumeQuote(q.id, 'u1');
    expect(legit).toBeNull();
  });
});
