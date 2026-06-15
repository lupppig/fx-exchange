import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { FxService } from './fx.service';
import {
  applySpread,
  convertSubunits,
  crossRate,
  parseRate,
} from '../wallet/utils/money';
import { isSupportedCurrency } from '../common/constants/supported-currencies';

/**
 * What the broker decides when issuing a quote.
 *
 *   - `side: SELL_BASE` means "user is selling fromCurrency, getting toCurrency".
 *     The user gets the BID side -- worse for them by half the spread.
 *
 * For a quote->trade RFQ flow we don't need separate BUY/SELL semantics
 * yet -- every user request is "convert X of from into to" which is
 * always a SELL of `from`. Future limit-order work can split the side.
 */
export interface Quote {
  id: string;
  userId: string;
  fromCurrency: string;
  toCurrency: string;
  /** subunit integer, what the user is selling */
  amountInSubunits: string;
  /** subunit integer the user receives after spread */
  amountOutSubunits: string;
  /** mid rate (provider) and effective rate (after spread) as strings */
  midRate: string;
  bid: string;
  ask: string;
  effectiveRate: string;
  /** ISO-8601 expiry */
  expiresAt: string;
  /** Quote was issued at this provider rate version -- traceability */
  rateVersion: string;
}

const QUOTE_KEY = (id: string) => `fx:quote:${id}`;

@Injectable()
export class QuoteService {
  private readonly logger = new Logger(QuoteService.name);
  private readonly spreadBps: number;
  private readonly ttlSeconds: number;

  constructor(
    private readonly fxService: FxService,
    private readonly config: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    // Default 50 bps = 0.50% total spread (25 bps each side of mid).
    // Comparable to Wise's posted rate spread on major pairs.
    this.spreadBps = this.config.get<number>('FX_SPREAD_BPS', 50);
    this.ttlSeconds = this.config.get<number>('FX_QUOTE_TTL_SECONDS', 10);
  }

  /**
   * Issue a quote for converting `amountInSubunits` of `fromCurrency` to
   * `toCurrency`. The quote is binding for `ttlSeconds` -- after that the
   * user must request a new one.
   *
   * The quote is stored in Redis under a single key, retrievable + deletable
   * atomically via GETDEL so a quote can only be redeemed once.
   */
  async createQuote(args: {
    userId: string;
    fromCurrency: string;
    toCurrency: string;
    amountInSubunits: bigint;
  }): Promise<Quote> {
    const { userId } = args;
    const fromCurrency = args.fromCurrency.toUpperCase();
    const toCurrency = args.toCurrency.toUpperCase();

    if (fromCurrency === toCurrency) {
      throw new BadRequestException('Cannot quote same-currency conversion');
    }
    if (!isSupportedCurrency(fromCurrency)) {
      throw new BadRequestException(`Unsupported currency: ${fromCurrency}`);
    }
    if (!isSupportedCurrency(toCurrency)) {
      throw new BadRequestException(`Unsupported currency: ${toCurrency}`);
    }
    if (args.amountInSubunits <= 0n) {
      throw new BadRequestException(
        'amountInSubunits must be a positive integer',
      );
    }

    const rates = await this.fxService.getRates();
    const midRate = crossRate(
      parseRate(rates.rates[fromCurrency]),
      parseRate(rates.rates[toCurrency]),
    );

    // For a user SELLING from-currency to get to-currency, they receive
    // the BID side of the spread -- the worse rate from their POV.
    const { bid, ask } = applySpread(midRate, this.spreadBps);
    const effectiveRate = bid;

    const amountOut = convertSubunits(
      args.amountInSubunits,
      fromCurrency,
      toCurrency,
      effectiveRate,
    );

    if (amountOut <= 0n) {
      throw new BadRequestException(
        'Amount too small to quote: would yield zero subunits after spread',
      );
    }

    const quote: Quote = {
      id: uuidv4(),
      userId,
      fromCurrency,
      toCurrency,
      amountInSubunits: args.amountInSubunits.toString(),
      amountOutSubunits: amountOut.toString(),
      midRate: midRate.toFixed(10),
      bid: bid.toFixed(10),
      ask: ask.toFixed(10),
      effectiveRate: effectiveRate.toFixed(10),
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString(),
      rateVersion: rates.version,
    };

    await this.redis.set(
      QUOTE_KEY(quote.id),
      JSON.stringify(quote),
      'EX',
      this.ttlSeconds,
    );

    this.logger.log({
      message: 'Quote issued',
      quoteId: quote.id,
      userId,
      fromCurrency,
      toCurrency,
      amountIn: quote.amountInSubunits,
      amountOut: quote.amountOutSubunits,
      effectiveRate: quote.effectiveRate,
      expiresAt: quote.expiresAt,
    });

    return quote;
  }

  /**
   * Atomically read and delete the quote, ensuring it can only be redeemed
   * once. Returns null if the quote is missing (expired, already redeemed,
   * or never existed -- the trade endpoint should treat all three the same).
   *
   * Also enforces userId binding: a quote issued to user A cannot be
   * redeemed by user B even if they somehow obtain the id.
   */
  async consumeQuote(quoteId: string, userId: string): Promise<Quote | null> {
    let raw: string | null = null;
    try {
      // GETDEL is atomic in Redis >= 6.2 -- one round trip, race-free.
      raw = await (
        this.redis as unknown as {
          getdel: (k: string) => Promise<string | null>;
        }
      ).getdel(QUOTE_KEY(quoteId));
    } catch (err) {
      // Some ioredis versions need the command registered. Fallback to
      // the slower but functionally equivalent GET + DEL pair.
      this.logger.warn(
        `GETDEL unavailable, falling back to GET+DEL: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      raw = await this.redis.get(QUOTE_KEY(quoteId));
      if (raw) await this.redis.del(QUOTE_KEY(quoteId));
    }

    if (!raw) return null;

    let parsed: Quote;
    try {
      parsed = JSON.parse(raw) as Quote;
    } catch {
      throw new InternalServerErrorException('Corrupt quote payload');
    }

    if (parsed.userId !== userId) {
      // The GETDEL above already removed the quote, but this caller is not its
      // owner -- consuming here would let an attacker burn another user's quote
      // just by guessing its id. Re-store it under its remaining TTL so the
      // rightful owner can still redeem it. Treat the result as "not found" to
      // avoid leaking which condition failed.
      const remainingMs = Date.parse(parsed.expiresAt) - Date.now();
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      if (remainingSeconds > 0) {
        await this.redis
          .set(QUOTE_KEY(quoteId), raw, 'EX', remainingSeconds)
          .catch((err) => {
            // Best effort: if re-storing fails the owner loses the quote, but
            // we never want to throw and expose the mismatch as a 500.
            this.logger.error({
              message: 'Failed to restore quote after user mismatch',
              quoteId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      this.logger.warn({
        message: 'Quote consume rejected: user mismatch',
        quoteId,
        expectedUserId: parsed.userId,
        actualUserId: userId,
      });
      return null;
    }

    return parsed;
  }
}
