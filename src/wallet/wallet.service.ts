import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, LessThan } from 'typeorm';
import { Wallet } from './entities/wallet.entity.js';
import { Balance } from './entities/balance.entity.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';
import { FxService } from '../fx/fx.service.js';
import { getSubunitFactor } from './utils/currency.util.js';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(TransactionLog)
    private readonly transactionLogRepository: Repository<TransactionLog>,
    private readonly dataSource: DataSource,
    private readonly fxService: FxService,
  ) {}

  async getWallet(userId: string) {
    let wallet = await this.walletRepository.findOne({
      where: { userId },
    });

    if (!wallet) {
      wallet = this.walletRepository.create({ userId });
      wallet = await this.walletRepository.save(wallet);
      wallet.balances = [];
    }

    return {
      walletId: wallet.id,
      userId: wallet.userId,
      balances: wallet.balances,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  async fundWallet(userId: string, currency: string, amount: number, idempotencyKey: string) {
    const normalizedCurrency = currency.toUpperCase();

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in smallest currency unit');
    }

    const existingLog = await this.transactionLogRepository.findOne({
      where: { idempotencyKey },
    });

    if (existingLog && existingLog.status === TransactionStatus.SUCCESS) {
      return {
        message: 'Transaction already processed',
        transaction: existingLog,
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      let wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
      });

      if (!wallet) {
        wallet = queryRunner.manager.create(Wallet, { userId });
        wallet = await queryRunner.manager.save(wallet);
      }

      let balance = await queryRunner.manager
        .createQueryBuilder(Balance, 'balance')
        .setLock('pessimistic_write')
        .where('balance.walletId = :walletId AND balance.currency = :currency', {
          walletId: wallet.id,
          currency: normalizedCurrency,
        })
        .getOne();

      const balanceBefore = balance ? Number(balance.amount) : 0;

      if (!balance) {
        balance = queryRunner.manager.create(Balance, {
          walletId: wallet.id,
          currency: normalizedCurrency,
          amount: 0,
        });
        balance = await queryRunner.manager.save(balance);
      }

      const balanceAfter = balanceBefore + amount;

      await queryRunner.manager.update(Balance, balance.id, { amount: balanceAfter });

      const txLog = queryRunner.manager.create(TransactionLog, {
        walletId: wallet.id,
        userId,
        type: TransactionType.CREDIT,
        purpose: TransactionPurpose.FUNDING,
        currency: normalizedCurrency,
        amount,
        balanceBefore,
        balanceAfter,
        exchangeRate: null,
        idempotencyKey,
        status: TransactionStatus.SUCCESS,
      });

      await queryRunner.manager.save(txLog);
      await queryRunner.commitTransaction();

      return {
        message: 'Wallet funded successfully',
        transaction: txLog,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to fund wallet');
    } finally {
      await queryRunner.release();
    }
  }

  async convertFunds(
    userId: string,
    fromCurrency: string,
    toCurrency: string,
    amount: number,
    idempotencyKey: string,
  ) {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) {
      throw new BadRequestException('Cannot convert to the same currency');
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in smallest currency unit');
    }

    const debitKey = `${idempotencyKey}:debit`;
    const creditKey = `${idempotencyKey}:credit`;

    const existingDebit = await this.transactionLogRepository.findOne({
      where: { idempotencyKey: debitKey },
    });

    if (existingDebit && existingDebit.status === TransactionStatus.SUCCESS) {
      const existingCredit = await this.transactionLogRepository.findOne({
        where: { idempotencyKey: creditKey },
      });
      return {
        message: 'Conversion already processed',
        debit: existingDebit,
        credit: existingCredit,
      };
    }

    const rates = await this.fxService.getRates();

    if (!rates.rates[from] || !rates.rates[to]) {
      throw new BadRequestException(
        `Unsupported currency pair: ${from}/${to}`,
      );
    }

    // Convert subunits: amount is in `from` subunits, we need `to` subunits
    const fromFactor = getSubunitFactor(from);
    const toFactor = getSubunitFactor(to);
    const exchangeRate = rates.rates[to] / rates.rates[from];

    // Convert: fromSubunits -> major units -> apply rate -> toSubunits
    const majorAmount = amount / fromFactor;
    const convertedMajor = majorAmount * exchangeRate;
    const convertedAmount = Math.round(convertedMajor * toFactor);

    if (convertedAmount <= 0) {
      throw new BadRequestException(
        `Amount too small to convert. ${amount} ${from} subunits converts to 0 ${to} subunits at the current rate.`,
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { userId },
      });

      if (!wallet) {
        throw new BadRequestException('Wallet not found');
      }

      const fromBalance = await queryRunner.manager
        .createQueryBuilder(Balance, 'balance')
        .setLock('pessimistic_write')
        .where('balance.walletId = :walletId AND balance.currency = :currency', {
          walletId: wallet.id,
          currency: from,
        })
        .getOne();

      if (!fromBalance || Number(fromBalance.amount) < amount) {
        const available = fromBalance ? Number(fromBalance.amount) : 0;
        throw new BadRequestException({
          message: `Insufficient ${from} balance`,
          error: 'INSUFFICIENT_BALANCE',
          details: {
            currency: from,
            available,
            requested: amount,
            shortfall: amount - available,
          },
        });
      }

      let toBalance = await queryRunner.manager
        .createQueryBuilder(Balance, 'balance')
        .setLock('pessimistic_write')
        .where('balance.walletId = :walletId AND balance.currency = :currency', {
          walletId: wallet.id,
          currency: to,
        })
        .getOne();

      if (!toBalance) {
        toBalance = queryRunner.manager.create(Balance, {
          walletId: wallet.id,
          currency: to,
          amount: 0,
        });
        toBalance = await queryRunner.manager.save(toBalance);
      }

      const fromBefore = Number(fromBalance.amount);
      const fromAfter = fromBefore - amount;
      const toBefore = Number(toBalance.amount);
      const toAfter = toBefore + convertedAmount;

      await queryRunner.manager.update(Balance, fromBalance.id, { amount: fromAfter });
      await queryRunner.manager.update(Balance, toBalance.id, { amount: toAfter });

      const debitLog = queryRunner.manager.create(TransactionLog, {
        walletId: wallet.id,
        userId,
        type: TransactionType.DEBIT,
        purpose: TransactionPurpose.EXCHANGE,
        currency: from,
        amount,
        balanceBefore: fromBefore,
        balanceAfter: fromAfter,
        exchangeRate,
        idempotencyKey: debitKey,
        status: TransactionStatus.SUCCESS,
      });

      const creditLog = queryRunner.manager.create(TransactionLog, {
        walletId: wallet.id,
        userId,
        type: TransactionType.CREDIT,
        purpose: TransactionPurpose.EXCHANGE,
        currency: to,
        amount: convertedAmount,
        balanceBefore: toBefore,
        balanceAfter: toAfter,
        exchangeRate,
        idempotencyKey: creditKey,
        status: TransactionStatus.SUCCESS,
      });

      await queryRunner.manager.save(debitLog);
      await queryRunner.manager.save(creditLog);
      await queryRunner.commitTransaction();

      return {
        message: 'Conversion successful',
        rateVersion: rates.version,
        exchangeRate,
        debit: debitLog,
        credit: creditLog,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Failed to convert funds');
    } finally {
      await queryRunner.release();
    }
  }

  async tradeFunds(
    userId: string,
    fromCurrency: string,
    toCurrency: string,
    amount: number,
    idempotencyKey: string,
  ) {
    return this.convertFunds(userId, fromCurrency, toCurrency, amount, idempotencyKey);
  }

  async getTransactions(userId: string, cursor?: string, limit: number = 20) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const take = safeLimit + 1;

    const whereCondition: Record<string, any> = { userId };
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (isNaN(cursorDate.getTime())) {
        throw new BadRequestException('Invalid cursor format. Use ISO 8601 timestamp.');
      }
      whereCondition.createdAt = LessThan(cursorDate);
    }

    const results = await this.transactionLogRepository.find({
      where: whereCondition,
      order: { createdAt: 'DESC' },
      take,
    });

    const hasMore = results.length > safeLimit;
    const transactions = hasMore ? results.slice(0, safeLimit) : results;
    const nextCursor = hasMore
      ? transactions[transactions.length - 1].createdAt.toISOString()
      : null;

    return {
      transactions,
      nextCursor,
      count: transactions.length,
    };
  }
}
