import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { OutboxEntry, OutboxStatus } from './entities/outbox-entry.entity.js';

@Injectable()
export class OutboxService {
  constructor(
    @InjectRepository(OutboxEntry)
    private readonly outboxRepo: Repository<OutboxEntry>,
  ) {}

  async addToOutbox(
    eventType: string,
    payload: Record<string, unknown>,
    queryRunner: QueryRunner,
  ): Promise<OutboxEntry> {
    const entry = queryRunner.manager.create(OutboxEntry, {
      eventType,
      payload,
      status: OutboxStatus.PENDING,
      retryCount: 0,
    });

    const saved = await queryRunner.manager.save(entry);

    return saved;
  }

  async getPendingEntries(limit: number): Promise<OutboxEntry[]> {
    return this.outboxRepo.find({
      where: { status: OutboxStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.outboxRepo.update(id, {
      status: OutboxStatus.PUBLISHED,
      publishedAt: new Date(),
    });
  }

  async markFailed(
    id: string,
    error: string,
    retryCount: number,
  ): Promise<void> {
    await this.outboxRepo.update(id, {
      status: retryCount > 0 ? OutboxStatus.PENDING : OutboxStatus.FAILED,
      lastError: error,
      retryCount,
    });
  }

  async getFailedEntries(): Promise<OutboxEntry[]> {
    return this.outboxRepo.find({
      where: { status: OutboxStatus.FAILED },
      order: { createdAt: 'ASC' },
    });
  }
}
