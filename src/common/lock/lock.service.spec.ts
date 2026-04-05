import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { LockService } from './lock.service.js';
import { Lock } from 'redlock';

describe('LockService', () => {
  let service: LockService;

  const mockLock: Lock = {
    release: jest.fn().mockResolvedValue(undefined),
    resources: ['test-resource'],
    value: 'lock-value',
    expiration: Date.now() + 10000,
  } as unknown as Lock;

  const mockRedis = {
    on: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LockService,
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: mockRedis,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(10000),
          },
        },
      ],
    }).compile();

    service = module.get<LockService>(LockService);
    service.onModuleInit();
  });

  it('should execute action and release lock on success', async () => {
    const action = jest.fn().mockResolvedValue('result');

    jest.spyOn(service['redlock'], 'acquire').mockResolvedValue(mockLock);

    const result = await service.acquire('test-resource', action);

    expect(result).toBe('result');
    expect(action).toHaveBeenCalled();
    expect(mockLock.release).toHaveBeenCalled();
  });

  it('should throw when lock cannot be acquired', async () => {
    const action = jest.fn();

    jest
      .spyOn(service['redlock'], 'acquire')
      .mockRejectedValue(new Error('Lock failed'));

    await expect(service.acquire('test-resource', action)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('should release lock even when action throws', async () => {
    const action = jest.fn().mockRejectedValue(new Error('Action failed'));

    jest.spyOn(service['redlock'], 'acquire').mockResolvedValue(mockLock);

    await expect(service.acquire('test-resource', action)).rejects.toThrow(
      'Action failed',
    );
    expect(mockLock.release).toHaveBeenCalled();
  });

  it('should use custom TTL when provided', async () => {
    const action = jest.fn().mockResolvedValue('result');
    const acquireSpy = jest
      .spyOn(service['redlock'], 'acquire')
      .mockResolvedValue(mockLock);

    await service.acquire('test-resource', action, 5000);

    expect(acquireSpy).toHaveBeenCalledWith(['test-resource'], 5000);
  });

  it('should use default TTL when not provided', async () => {
    const action = jest.fn().mockResolvedValue('result');
    const acquireSpy = jest
      .spyOn(service['redlock'], 'acquire')
      .mockResolvedValue(mockLock);

    await service.acquire('test-resource', action);

    expect(acquireSpy).toHaveBeenCalledWith(['test-resource'], 10000);
  });
});
