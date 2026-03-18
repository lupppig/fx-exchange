import { plainToInstance } from 'class-transformer';
import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { JournalEntry } from './entities/journal-entry.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';

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
    @Inject('TRANSACTIONS_SERVICE') private readonly client: ClientProxy,
  ) {}

  /**
   * Records a journal entry with its linked ledger entries asynchronously via RabbitMQ.
   * Returns the journal entry immediately for a fast API response.
   */
  async recordJournalEntry(
    options: RecordJournalOptions,
  ): Promise<JournalEntry> {
    const journalId = uuidv4();
    const now = new Date();

    const entries = options.entries.map((entry) => ({
      ...entry,
      id: uuidv4(),
      journalEntryId: journalId,
      createdAt: now,
    }));

    const journalData = {
      id: journalId,
      walletId: options.walletId,
      userId: options.userId,
      purpose: options.purpose,
      status: options.status ?? TransactionStatus.PENDING,
      idempotencyKey: options.idempotencyKey,
      exchangeRate: options.exchangeRate ?? null,
      entries,
      createdAt: now,
      updatedAt: now,
    };

    this.client.emit('record_journal', journalData);

    return plainToInstance(JournalEntry, journalData);
  }

  /**
   * Updates the status of a journal entry asynchronously via RabbitMQ.
   */
  async updateJournalStatus(
    journalId: string,
    status: TransactionStatus,
    entryUpdates?: { entryId: string; balanceBefore: number; balanceAfter: number }[],
  ): Promise<void> {
    this.client.emit('update_journal', { journalId, status, entryUpdates });
  }

  /**
   * Finds a journal entry by its idempotency key (synchronous DB read).
   */
  async findByIdempotencyKey(userId: string, key: string): Promise<JournalEntry | null> {
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
      qb.andWhere('entry.currency = :currency', { currency: currency.toUpperCase() });
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
    const nextCursor = hasNextPage ? items[items.length - 1].createdAt.toISOString() : null;

    return {
      items,
      nextCursor,
      hasNextPage,
    };
  }
}
