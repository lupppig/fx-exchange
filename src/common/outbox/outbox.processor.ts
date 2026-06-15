import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { OutboxService } from './outbox.service';
import { OutboxEntry } from './entities/outbox-entry.entity';

@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private readonly maxRetries: number;
  private readonly batchSize: number;
  private readonly staleAfterMs: number;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService,
    private readonly amqpConnection: AmqpConnection,
  ) {
    this.maxRetries = this.configService.get<number>('OUTBOX_MAX_RETRIES', 5);
    this.batchSize = this.configService.get<number>('OUTBOX_BATCH_SIZE', 50);
    // A row stuck in PROCESSING longer than this is assumed to be from a
    // dead replica and gets reverted to PENDING by the recovery sweep.
    this.staleAfterMs = this.configService.get<number>(
      'OUTBOX_STALE_AFTER_MS',
      60_000,
    );
  }

  onModuleInit() {
    this.intervalId = setInterval(
      () => {
        this.processOutbox().catch((error) => {
          this.logger.error('Outbox processing interval failed:', error);
        });
      },
      this.configService.get<number>('OUTBOX_POLL_INTERVAL_MS', 2000),
    );
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  /**
   * Periodically revert PROCESSING rows abandoned by a crashed replica.
   * Cheap: a single UPDATE keyed on (status, claimedAt). The poll loop
   * will then re-claim and republish them.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStuckEntries() {
    try {
      const recovered = await this.outboxService.recoverStuckEntries(
        this.staleAfterMs,
      );
      if (recovered > 0) {
        this.logger.warn(
          `Recovered ${recovered} stuck outbox entries (stale > ${this.staleAfterMs}ms)`,
        );
      }
    } catch (error) {
      this.logger.error('Outbox recovery sweep failed:', error);
    }
  }

  async processOutbox() {
    // Atomically claim a batch -- concurrent replicas split the work
    // via FOR UPDATE SKIP LOCKED and never see the same row twice.
    const claimed = await this.outboxService.claimPendingEntries(
      this.batchSize,
    );

    if (claimed.length === 0) {
      return;
    }

    this.logger.log(`Processing ${claimed.length} outbox entries`);

    for (const entry of claimed) {
      await this.publishEntry(entry);
    }
  }

  private async publishEntry(entry: OutboxEntry): Promise<void> {
    try {
      await this.amqpConnection.publish(
        'fx_exchange_events',
        entry.eventType,
        entry.payload,
        {
          persistent: true,
          headers: {
            'x-outbox-id': entry.id,
            'x-retry-count': entry.retryCount,
          },
        },
      );

      await this.outboxService.markPublished(entry.id);
      this.logger.log(`Outbox entry ${entry.id} published successfully`);
    } catch (error) {
      const retryCount = entry.retryCount + 1;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const exhausted = retryCount >= this.maxRetries;
      if (exhausted) {
        this.logger.error(
          `Outbox entry ${entry.id} exhausted retries (${retryCount}/${this.maxRetries}): ${errorMessage}. Moved to dead letter.`,
        );
      } else {
        this.logger.error(
          `Failed to publish outbox entry ${entry.id} (attempt ${retryCount}/${this.maxRetries}): ${errorMessage}`,
        );
      }

      await this.outboxService.markFailed(
        entry.id,
        errorMessage,
        retryCount,
        this.maxRetries,
      );
    }
  }
}
