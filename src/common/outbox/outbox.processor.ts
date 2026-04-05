import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { OutboxService } from './outbox.service.js';
import { OutboxEntry } from './entities/outbox-entry.entity.js';

@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private readonly maxRetries: number;
  private readonly batchSize: number;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService,
    private readonly amqpConnection: AmqpConnection,
  ) {
    this.maxRetries = this.configService.get<number>('OUTBOX_MAX_RETRIES', 5);
    this.batchSize = this.configService.get<number>('OUTBOX_BATCH_SIZE', 50);
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

  @Cron(CronExpression.EVERY_MINUTE)
  async retryFailedEntries() {
    const failedEntries = await this.outboxService.getFailedEntries();

    for (const entry of failedEntries) {
      if (entry.retryCount < this.maxRetries) {
        this.logger.log(
          `Retrying failed outbox entry ${entry.id} (attempt ${entry.retryCount + 1})`,
        );
        await this.publishEntry(entry);
      } else {
        this.logger.error(
          `Outbox entry ${entry.id} exceeded max retries (${this.maxRetries}). Moved to dead letter.`,
        );
      }
    }
  }

  async processOutbox() {
    const pendingEntries = await this.outboxService.getPendingEntries(
      this.batchSize,
    );

    if (pendingEntries.length === 0) {
      return;
    }

    this.logger.log(`Processing ${pendingEntries.length} outbox entries`);

    for (const entry of pendingEntries) {
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

      this.logger.error(
        `Failed to publish outbox entry ${entry.id} (attempt ${retryCount}/${this.maxRetries}): ${errorMessage}`,
      );

      await this.outboxService.markFailed(entry.id, errorMessage, retryCount);
    }
  }
}
