import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import axiosRetry from 'axios-retry';

interface FxRateResponse {
  result: string;
  base_code: string;
  time_last_update_unix: number;
  conversion_rates: Record<string, number>;
}

export interface VersionedRates {
  version: string;
  base: string;
  timestamp: string;
  rates: Record<string, number>;
}

const CACHE_KEY_FRESH = 'fx:rates:fresh';
const CACHE_KEY_FALLBACK = 'fx:rates:fallback';
const CACHE_TTL_SECONDS = 90;

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.apiKey = this.configService.get<string>('EXCHANGE_RATE_API_KEY', '');
    this.maxRetries = this.configService.get<number>('FX_RETRY_MAX', 3);
    this.baseDelayMs = this.configService.get<number>('FX_RETRY_BASE_DELAY_MS', 300);
    this.requestTimeoutMs = this.configService.get<number>('FX_REQUEST_TIMEOUT_MS', 5000);

    this.configureRetry();
  }

  /**
   * Configures axios-retry with exponential backoff + jitter.
   *
   * Delay formula (built into axios-retry.exponentialDelay):
   *   delay = 2^(attempt-1) * baseDelay * (1 + random jitter)
   *
   * Example with baseDelay = 300ms:
   *   Attempt 1 → ~300ms  (+ jitter)
   *   Attempt 2 → ~600ms  (+ jitter)
   *   Attempt 3 → ~1200ms (+ jitter)
   *
   * Timeout escalation: each retry doubles the request timeout
   * to give the provider more breathing room on recovery.
   */
  private configureRetry(): void {
    const baseTimeout = this.requestTimeoutMs;

    axiosRetry(this.httpService.axiosRef, {
      retries: this.maxRetries,
      retryDelay: (retryCount) => {
        // exponentialDelay already applies jitter internally
        return axiosRetry.exponentialDelay(retryCount, undefined, this.baseDelayMs);
      },
      retryCondition: (error) => {
        return (
          axiosRetry.isNetworkOrIdempotentRequestError(error) ||
          error.response?.status === 429 ||
          (error.response?.status ?? 0) >= 500
        );
      },
      onRetry: (retryCount, error, requestConfig) => {
        // Escalate timeout: double it for each retry attempt
        requestConfig.timeout = baseTimeout * Math.pow(2, retryCount);

        this.logger.warn(
          `FX API retry ${retryCount}/${this.maxRetries} — ` +
          `error: ${error.message} | ` +
          `next timeout: ${requestConfig.timeout}ms`,
        );
      },
    });

    this.logger.log(
      `FX retry configured: maxRetries=${this.maxRetries}, ` +
      `baseDelay=${this.baseDelayMs}ms, timeout=${this.requestTimeoutMs}ms`,
    );
  }

  async getRates(): Promise<VersionedRates> {
    const cached = await this.redis.get(CACHE_KEY_FRESH);
    if (cached) {
      return JSON.parse(cached) as VersionedRates;
    }

    return this.fetchAndCacheRates();
  }

  private async fetchAndCacheRates(): Promise<VersionedRates> {
    try {
      const url = `https://v6.exchangerate-api.com/v6/${this.apiKey}/latest/NGN`;
      const { data } = await firstValueFrom(
        this.httpService.get<FxRateResponse>(url, { timeout: this.requestTimeoutMs }),
      );

      if (data.result !== 'success') {
        throw new Error(`ExchangeRate-API returned result: ${data.result}`);
      }

      const versionedRates: VersionedRates = {
        version: uuidv4(),
        base: data.base_code,
        timestamp: new Date(data.time_last_update_unix * 1000).toISOString(),
        rates: data.conversion_rates,
      };

      const payload = JSON.stringify(versionedRates);
      await this.redis.set(CACHE_KEY_FRESH, payload, 'EX', CACHE_TTL_SECONDS);
      await this.redis.set(CACHE_KEY_FALLBACK, payload);

      this.logger.log('FX rates fetched and cached successfully');
      return versionedRates;
    } catch (error) {
      this.logger.warn(
        `FX rate fetch failed after ${this.maxRetries} retries: ${(error as Error).message}`,
      );
      return this.getFallbackRates();
    }
  }

  private async getFallbackRates(): Promise<VersionedRates> {
    const fallback = await this.redis.get(CACHE_KEY_FALLBACK);
    if (fallback) {
      this.logger.warn('Using fallback (last known) FX rates');
      return JSON.parse(fallback) as VersionedRates;
    }

    throw new InternalServerErrorException(
      'FX rates are temporarily unavailable. Please try again later.',
    );
  }
}

