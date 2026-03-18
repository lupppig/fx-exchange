import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { FxService } from './fx.service';

const ENV_DEFAULTS: Record<string, string | number> = {
  EXCHANGE_RATE_API_KEY: 'test-api-key',
  FX_RETRY_MAX: 3,
  FX_RETRY_BASE_DELAY_MS: 300,
  FX_REQUEST_TIMEOUT_MS: 5000,
};

describe('FxService', () => {
  let service: FxService;
  let httpService: jest.Mocked<HttpService>;
  let redisClient: Record<string, jest.Mock>;

  beforeEach(async () => {
    redisClient = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FxService,
        {
          provide: HttpService,
          useValue: {
            get: jest.fn(),
            axiosRef: { interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) =>
              ENV_DEFAULTS[key] ?? fallback,
            ),
          },
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: redisClient,
        },
      ],
    }).compile();

    service = module.get<FxService>(FxService);
    httpService = module.get(HttpService) as jest.Mocked<HttpService>;
  });

  it('should return cached rates on cache hit', async () => {
    const cachedData = JSON.stringify({
      version: 'abc-123',
      base: 'USD',
      timestamp: '2026-03-17T00:00:00.000Z',
      rates: { USD: 1, EUR: 0.92 },
    });
    redisClient.get.mockResolvedValue(cachedData);

    const result = await service.getRates();

    expect(result.version).toBe('abc-123');
    expect(result.rates.EUR).toBe(0.92);
    expect(httpService.get).not.toHaveBeenCalled();
  });

  it('should fetch from API on cache miss and store in Redis', async () => {
    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockResolvedValue('OK');

    httpService.get.mockReturnValue(
      of({
        data: {
          result: 'success',
          base_code: 'USD',
          time_last_update_unix: 1742169600,
          conversion_rates: { USD: 1, EUR: 0.92, GBP: 0.79 },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      }),
    );

    const result = await service.getRates();

    expect(result.base).toBe('USD');
    expect(result.rates.EUR).toBe(0.92);
    expect(result.rates.GBP).toBe(0.79);
    expect(result.version).toBeDefined();
    expect(redisClient.set).toHaveBeenCalledTimes(2);
  });

  it('should fall back to last known rates when API fails', async () => {
    redisClient.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          version: 'fallback-v1',
          base: 'USD',
          timestamp: '2026-03-16T00:00:00.000Z',
          rates: { USD: 1, NGN: 1550 },
        }),
      );

    httpService.get.mockReturnValue(
      throwError(() => new Error('Network error')),
    );

    const result = await service.getRates();

    expect(result.version).toBe('fallback-v1');
    expect(result.rates.NGN).toBe(1550);
  });

  it('should throw InternalServerErrorException when API fails and no fallback exists', async () => {
    redisClient.get.mockResolvedValue(null);

    httpService.get.mockReturnValue(
      throwError(() => new Error('Network error')),
    );

    await expect(service.getRates()).rejects.toThrow(InternalServerErrorException);
  });
});
