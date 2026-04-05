import {
  Injectable,
  OnModuleInit,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';

@Injectable()
export class LockService implements OnModuleInit {
  private redlock!: Redlock;
  private readonly logger = new Logger(LockService.name);
  private readonly defaultTtl: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.defaultTtl = this.configService.get<number>('LOCK_TTL_MS', 10000);
  }

  onModuleInit() {
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 50,
      retryDelay: 200,
      retryJitter: 200,
    });
  }

  /**
   * Acquires a lock for a specific resource and executes the provided action.
   * Ensures the lock is released regardless of success or failure.
   */
  async acquire<T>(
    resource: string,
    action: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const lockTtl = ttl ?? this.defaultTtl;

    let lock: Lock;
    try {
      lock = await this.redlock.acquire([resource], lockTtl);
    } catch (error) {
      this.logger.warn(`Could not acquire lock for ${resource}`);
      throw new InternalServerErrorException(
        'System is busy, please try again later',
      );
    }

    try {
      return await action();
    } finally {
      try {
        await lock.release();
      } catch (error) {
        this.logger.error(`Failed to release lock for ${resource}:`, error);
      }
    }
  }
}
