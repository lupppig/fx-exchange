import { Injectable, OnModuleInit, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';

@Injectable()
export class LockService implements OnModuleInit {
  private redlock!: Redlock;
  private readonly logger = new Logger(LockService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  onModuleInit() {
    this.redlock = new Redlock(
      [this.redis as any],
      {
        driftFactor: 0.01,
        retryCount: 50,
        retryDelay: 200,
        retryJitter: 200,
      }
    );

    // In v5, redlock might not emit 'error' directly on the instance the same way
    // or it might be 'clientError'
  }

  /**
   * Acquires a lock for a specific resource and executes the provided action.
   * Ensures the lock is released regardless of success or failure.
   */
  async acquire<T>(
    resource: string,
    ttl: number,
    action: () => Promise<T>,
  ): Promise<T> {
    let lock: Lock;
    try {
      lock = await this.redlock.acquire([resource], ttl);
    } catch (error) {
      this.logger.warn(`Could not acquire lock for ${resource}`);
      throw new InternalServerErrorException('System is busy, please try again later');
    }

    try {
      return await action();
    } finally {
      try {
        await this.redlock.release(lock);
      } catch (error) {
        this.logger.error(`Failed to release lock for ${resource}:`, error);
      }
    }
  }
}
