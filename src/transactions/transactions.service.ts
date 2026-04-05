import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { JournalEntry } from './entities/journal-entry.entity.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';
import { OutboxService } from '../common/outbox/outbox.service.js';

export interface LedgerEntryInput {
  walletId: string;
  userId: string;
  type: TransactionType;
  currency: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface RecordJournalOptions {
  walletId: string;
  userId: string;
  purpose: TransactionPurpose;
  idempotencyKey: string;
  status?: TransactionStatus;
  exchangeRate?: number;
  entries: LedgerEntryInput[];
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(JournalEntry)
    private readonly journalRepo: Repository<JournalEntry>,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * Records a journal entry with its linked ledger entries synchronously
   * within the provided QueryRunner's transaction.
   * Returns the persisted journal entry.
   */
  async recordJournalEntry(
    options: RecordJournalOptions,
    queryRunner: QueryRunner,
  ): Promise<JournalEntry> {
    const journal = queryRunner.manager.create(JournalEntry, {
      walletId: options.walletId,
      userId: options.userId,
      purpose: options.purpose,
      status: options.status ?? TransactionStatus.PENDING,
      idempotencyKey: options.idempotencyKey,
      exchangeRate: options.exchangeRate ?? null,
    });

    const savedJournal = await queryRunner.manager.save(journal);

    const entries = options.entries.map((entry) =>
      queryRunner.manager.create(TransactionLog, {
        journalEntry: savedJournal,
        walletId: entry.walletId,
        userId: entry.userId,
        type: entry.type,
        currency: entry.currency,
        amount: entry.amount,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
      }),
    );

    await queryRunner.manager.save(entries);

    await this.outboxService.addToOutbox(
      'journal.created',
      {
        journalId: savedJournal.id,
        walletId: options.walletId,
        userId: options.userId,
        purpose: options.purpose,
        status: options.status ?? TransactionStatus.PENDING,
        idempotencyKey: options.idempotencyKey,
        exchangeRate: options.exchangeRate ?? null,
        entries: options.entries,
      },
      queryRunner,
    );

    const saved = await queryRunner.manager.findOne(JournalEntry, {
      where: { id: savedJournal.id },
      relations: ['entries'],
    });

    if (!saved) {
      throw new Error('Failed to retrieve saved journal entry');
    }

    return saved;
  }

  /**
   * Updates the status of a journal entry and its ledger entries
   * synchronously within the provided QueryRunner's transaction.
   */
  async updateJournalStatus(
    journalId: string,
    status: TransactionStatus,
    queryRunner: QueryRunner,
    entryUpdates?: {
      entryId: string;
      balanceBefore: number;
      balanceAfter: number;
    }[],
  ): Promise<void> {
    await queryRunner.manager.update(JournalEntry, journalId, { status });

    if (entryUpdates) {
      for (const update of entryUpdates) {
        await queryRunner.manager.update(TransactionLog, update.entryId, {
          balanceBefore: update.balanceBefore,
          balanceAfter: update.balanceAfter,
        });
      }
    }
  }

  /**
   * Finds a journal entry by its idempotency key (synchronous DB read).
   */
  async findByIdempotencyKey(
    userId: string,
    key: string,
  ): Promise<JournalEntry | null> {
    return this.journalRepo.findOne({
      where: { userId, idempotencyKey: key },
      relations: ['entries'],
    });
  }

  /**
   * Fetches transaction history for a user with cursor-based pagination and filtering.
   * Queries journal entries with their linked ledger entries.
   */
  async getTransactions(
    userId: string,
    query: {
      cursor?: string;
      limit?: number;
      currency?: string;
      type?: TransactionType;
      purpose?: TransactionPurpose;
    },
  ) {
    const { cursor, limit = 20, currency, type, purpose } = query;

    const qb = this.journalRepo
      .createQueryBuilder('journal')
      .leftJoinAndSelect('journal.entries', 'entry')
      .where('journal.userId = :userId', { userId })
      .orderBy('journal.createdAt', 'DESC')
      .take(limit + 1);

    if (cursor) {
      qb.andWhere('journal.createdAt < :cursor', { cursor });
    }

    if (currency) {
      qb.andWhere('entry.currency = :currency', {
        currency: currency.toUpperCase(),
      });
    }

    if (type) {
      qb.andWhere('entry.type = :type', { type });
    }

    if (purpose) {
      qb.andWhere('journal.purpose = :purpose', { purpose });
    }

    const journals = await qb.getMany();

    const hasNextPage = journals.length > limit;
    const items = hasNextPage ? journals.slice(0, limit) : journals;
    const nextCursor = hasNextPage
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return {
      items,
      nextCursor,
      hasNextPage,
    };
  }
}
