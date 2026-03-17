import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

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

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.apiKey = this.configService.get<string>('EXCHANGE_RATE_API_KEY', '');
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
      const url = `https://v6.exchangerate-api.com/v6/${this.apiKey}/latest/USD`;
      const { data } = await firstValueFrom(
        this.httpService.get<FxRateResponse>(url, { timeout: 5000 }),
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
      this.logger.warn(`Failed to fetch FX rates from external API: ${(error as Error).message}`);
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
