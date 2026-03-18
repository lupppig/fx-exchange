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
import { isSupportedCurrency } from '../common/constants/supported-currencies.js';

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

    if (!isSupportedCurrency(normalizedCurrency)) {
      throw new BadRequestException(`Unsupported currency: ${normalizedCurrency}`);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in smallest currency unit');
    }

    // 1. Check existing state
    const existingLog = await this.transactionLogRepository.findOne({
      where: { idempotencyKey },
    });

    if (existingLog) {
      if (existingLog.status === TransactionStatus.SUCCESS) {
        return {
          message: 'Transaction already processed',
          status: existingLog.status,
          transaction: existingLog,
        };
      }
      if (existingLog.status === TransactionStatus.PENDING) {
        throw new BadRequestException('Transaction is currently being processed. Please wait.');
      }
      if (existingLog.status === TransactionStatus.FAILED) {
        throw new BadRequestException('Transaction previously failed. Please use a new idempotency key.');
      }
    }

    // 2. Early Claim (PENDING status)
    // We need a walletId for the log. Ensure wallet exists first.
    let wallet = await this.walletRepository.findOne({ where: { userId } });
    if (!wallet) {
      wallet = this.walletRepository.create({ userId });
      wallet = await this.walletRepository.save(wallet);
    }

    const pendingLog = this.transactionLogRepository.create({
      walletId: wallet.id,
      userId,
      type: TransactionType.CREDIT,
      purpose: TransactionPurpose.FUNDING,
      currency: normalizedCurrency,
      amount,
      balanceBefore: 0, // Will be updated
      balanceAfter: 0,  // Will be updated
      idempotencyKey,
      status: TransactionStatus.PENDING,
    });
    await this.transactionLogRepository.save(pendingLog);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
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

      // 3. Update log to SUCCESS
      await queryRunner.manager.update(TransactionLog, pendingLog.id, {
        balanceBefore,
        balanceAfter,
        status: TransactionStatus.SUCCESS,
      });

      await queryRunner.commitTransaction();

      const finalLog = await this.transactionLogRepository.findOneOrFail({ where: { id: pendingLog.id } });

      return {
        message: 'Wallet funded successfully',
        status: finalLog.status,
        transaction: finalLog,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      await this.transactionLogRepository.update(pendingLog.id, { status: TransactionStatus.FAILED });
      
      if (error instanceof BadRequestException) throw error;
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
    context: 'convert' | 'trade' = 'convert',
  ) {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) {
      throw new BadRequestException('Cannot convert to the same currency');
    }

    if (!isSupportedCurrency(from)) {
      throw new BadRequestException(`Unsupported currency: ${from}`);
    }
    if (!isSupportedCurrency(to)) {
      throw new BadRequestException(`Unsupported currency: ${to}`);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in smallest currency unit');
    }

    const debitKey = `${idempotencyKey}:debit`;
    const creditKey = `${idempotencyKey}:credit`;

    // 1. Check existing state
    const existingDebit = await this.transactionLogRepository.findOne({
      where: { idempotencyKey: debitKey },
    });

    if (existingDebit) {
      if (existingDebit.status === TransactionStatus.SUCCESS) {
        const existingCredit = await this.transactionLogRepository.findOne({
          where: { idempotencyKey: creditKey },
        });
        return {
          message: 'Conversion already processed',
          status: existingDebit.status,
          debit: existingDebit,
          credit: existingCredit,
        };
      }
      if (existingDebit.status === TransactionStatus.PENDING) {
        throw new BadRequestException('Conversion is currently being processed. Please wait.');
      }
      if (existingDebit.status === TransactionStatus.FAILED) {
        throw new BadRequestException('Conversion previously failed. Please use a new idempotency key.');
      }
    }

    const rates = await this.fxService.getRates();

    if (!rates.rates[from] || !rates.rates[to]) {
      throw new BadRequestException(`Unsupported currency pair: ${from}/${to}`);
    }

    const fromFactor = getSubunitFactor(from);
    const toFactor = getSubunitFactor(to);
    const exchangeRate = rates.rates[to] / rates.rates[from];

    const majorAmount = amount / fromFactor;
    const convertedMajor = majorAmount * exchangeRate;
    const convertedAmount = Math.round(convertedMajor * toFactor);

    if (convertedAmount <= 0) {
      throw new BadRequestException(`Amount too small to ${context}.`);
    }

    // 2. Early Claim (PENDING status)
    let wallet = await this.walletRepository.findOne({ where: { userId } });
    if (!wallet) {
      wallet = this.walletRepository.create({ userId });
      wallet = await this.walletRepository.save(wallet);
    }

    const pendingDebit = this.transactionLogRepository.create({
      walletId: wallet.id,
      userId,
      type: TransactionType.DEBIT,
      purpose: TransactionPurpose.EXCHANGE,
      currency: from,
      amount,
      balanceBefore: 0,
      balanceAfter: 0,
      exchangeRate,
      idempotencyKey: debitKey,
      status: TransactionStatus.PENDING,
    });

    const pendingCredit = this.transactionLogRepository.create({
      walletId: wallet.id,
      userId,
      type: TransactionType.CREDIT,
      purpose: TransactionPurpose.EXCHANGE,
      currency: to,
      amount: convertedAmount,
      balanceBefore: 0,
      balanceAfter: 0,
      exchangeRate,
      idempotencyKey: creditKey,
      status: TransactionStatus.PENDING,
    });

    await this.transactionLogRepository.save([pendingDebit, pendingCredit]);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const fromBalance = await queryRunner.manager
        .createQueryBuilder(Balance, 'balance')
        .setLock('pessimistic_write')
        .where('balance.walletId = :walletId AND balance.currency = :currency', {
          walletId: wallet.id,
          currency: from,
        })
        .getOne();

      if (!fromBalance || Number(fromBalance.amount) < amount) {
        throw new BadRequestException(`Insufficient ${from} balance`);
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

      // 3. Update logs to SUCCESS
      await queryRunner.manager.update(TransactionLog, pendingDebit.id, {
        balanceBefore: fromBefore,
        balanceAfter: fromAfter,
        status: TransactionStatus.SUCCESS,
      });

      await queryRunner.manager.update(TransactionLog, pendingCredit.id, {
        balanceBefore: toBefore,
        balanceAfter: toAfter,
        status: TransactionStatus.SUCCESS,
      });

      await queryRunner.commitTransaction();

      const finalDebit = await this.transactionLogRepository.findOneOrFail({ where: { id: pendingDebit.id } });
      const finalCredit = await this.transactionLogRepository.findOneOrFail({ where: { id: pendingCredit.id } });

      return {
        message: 'Conversion successful',
        status: finalDebit.status,
        rateVersion: rates.version,
        exchangeRate,
        debit: finalDebit,
        credit: finalCredit,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      await this.transactionLogRepository.update(
        [pendingDebit.id, pendingCredit.id],
        { status: TransactionStatus.FAILED }
      );
      
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
    return this.convertFunds(userId, fromCurrency, toCurrency, amount, idempotencyKey, 'trade');
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
