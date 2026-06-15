import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { OutboxEntry, OutboxStatus } from './entities/outbox-entry.entity';

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

  /**
   * Atomically claim up to `limit` PENDING rows for this processor instance
   * by flipping them to PROCESSING. Uses SELECT ... FOR UPDATE SKIP LOCKED
   * so concurrent replicas split the batch without blocking or duplicating.
   * Returns the claimed rows; callers must publish them and then
   * markPublished / markFailed each one.
   */
  async claimPendingEntries(limit: number): Promise<OutboxEntry[]> {
    // pg driver: an UPDATE ... RETURNING comes back as [rows, affected].
    // Unwrap to the row array (mirrors recoverStuckEntries' normalisation).
    const result: [OutboxEntry[], number] = await this.outboxRepo.query(
      `
      UPDATE outbox_entries
         SET status = $1, "claimedAt" = now(), "updatedAt" = now()
       WHERE id IN (
         SELECT id FROM outbox_entries
          WHERE status = $2
          ORDER BY "createdAt" ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
      RETURNING *
      `,
      [OutboxStatus.PROCESSING, OutboxStatus.PENDING, limit],
    );

    return result[0];
  }

  /**
   * Revert PROCESSING rows whose claim is older than `staleAfterMs` back to
   * PENDING so another replica can re-claim them. Returns the number of
   * rows recovered.
   */
  async recoverStuckEntries(staleAfterMs: number): Promise<number> {
    const result: unknown = await this.outboxRepo.query(
      `
      UPDATE outbox_entries
         SET status = $1, "claimedAt" = NULL, "updatedAt" = now()
       WHERE status = $2
         AND "claimedAt" IS NOT NULL
         AND "claimedAt" < (now() - ($3 || ' milliseconds')::interval)
      `,
      [OutboxStatus.PENDING, OutboxStatus.PROCESSING, String(staleAfterMs)],
    );

    // pg driver: UPDATE returns [rows, affected]. Normalise.
    if (Array.isArray(result) && typeof result[1] === 'number') {
      return result[1];
    }
    return 0;
  }

  async markPublished(id: string): Promise<void> {
    await this.outboxRepo.update(id, {
      status: OutboxStatus.PUBLISHED,
      publishedAt: new Date(),
      claimedAt: null,
    });
  }

  /**
   * Record a failed publish attempt. If retryCount has reached maxRetries
   * the row moves to FAILED (terminal, dead-letter). Otherwise it goes
   * back to PENDING for the next poll cycle.
   */
  async markFailed(
    id: string,
    error: string,
    retryCount: number,
    maxRetries: number,
  ): Promise<void> {
    const exhausted = retryCount >= maxRetries;
    await this.outboxRepo.update(id, {
      status: exhausted ? OutboxStatus.FAILED : OutboxStatus.PENDING,
      lastError: error,
      retryCount,
      claimedAt: null,
    });
  }

  async getFailedEntries(): Promise<OutboxEntry[]> {
    return this.outboxRepo.find({
      where: { status: OutboxStatus.FAILED },
      order: { createdAt: 'ASC' },
    });
  }
}
