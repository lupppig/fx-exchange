import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
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
    private readonly repo: Repository<TransactionLog>,
    @Inject('TRANSACTIONS_SERVICE') private readonly client: ClientProxy,
  ) {}

  /**
   * Records a new transaction in the ledger asynchronously.
   */
  async recordTransaction(
    options: RecordTransactionOptions,
  ): Promise<TransactionLog> {
    const id = uuidv4();
    const log = {
      ...options,
      id,
      status: options.status ?? TransactionStatus.SUCCESS,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TransactionLog;

    this.client.emit('record_transaction', log);

    return log;
  }

  /**
   * Updates the status or details of an existing transaction asynchronously.
   */
  async updateTransaction(
    id: string,
    update: Partial<TransactionLog>,
  ): Promise<void> {
    this.client.emit('update_transaction', { id, update });
  }

  /**
   * Finds a transaction by its idempotency key.
   */
  async findByIdempotencyKey(key: string): Promise<TransactionLog | null> {
    return this.repo.findOne({ where: { idempotencyKey: key } });
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

    const qb = this.repo
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
