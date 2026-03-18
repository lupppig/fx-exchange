import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';

export interface RecordTransactionOptions {
  walletId: string;
  userId: string;
  type: TransactionType;
  purpose: TransactionPurpose;
  currency: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  idempotencyKey: string;
  status?: TransactionStatus;
  exchangeRate?: number;
  metadata?: any;
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(TransactionLog)
    private readonly transactionLogRepository: Repository<TransactionLog>,
  ) {}

  /**
   * Records a new transaction in the ledger.
   */
  async recordTransaction(
    options: RecordTransactionOptions,
    manager?: EntityManager,
  ): Promise<TransactionLog> {
    const repo = manager ? manager.getRepository(TransactionLog) : this.transactionLogRepository;
    const log = repo.create({
      ...options,
      status: options.status ?? TransactionStatus.SUCCESS,
    });
    return repo.save(log);
  }

  /**
   * Updates the status or details of an existing transaction.
   */
  async updateTransaction(
    id: string,
    update: Partial<TransactionLog>,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(TransactionLog) : this.transactionLogRepository;
    await repo.update(id, update);
  }

  /**
   * Finds a transaction by its idempotency key.
   */
  async findByIdempotencyKey(key: string): Promise<TransactionLog | null> {
    return this.transactionLogRepository.findOne({ where: { idempotencyKey: key } });
  }

  /**
   * Fetches transaction history for a user with cursor-based pagination and advanced filtering.
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

    const qb = this.transactionLogRepository
      .createQueryBuilder('txn')
      .where('txn.userId = :userId', { userId })
      .orderBy('txn.createdAt', 'DESC')
      .take(limit + 1);

    if (cursor) {
      qb.andWhere('txn.createdAt < :cursor', { cursor });
    }

    if (currency) {
      qb.andWhere('txn.currency = :currency', { currency: currency.toUpperCase() });
    }

    if (type) {
      qb.andWhere('txn.type = :type', { type });
    }

    if (purpose) {
      qb.andWhere('txn.purpose = :purpose', { purpose });
    }

    const txns = await qb.getMany();

    const hasNextPage = txns.length > limit;
    const items = hasNextPage ? txns.slice(0, limit) : txns;
    const nextCursor = hasNextPage ? items[items.length - 1].createdAt.toISOString() : null;

    return {
      items,
      nextCursor,
      hasNextPage,
    };
  }
}
