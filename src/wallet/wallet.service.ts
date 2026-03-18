import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity.js';
import { Balance } from './entities/balance.entity.js';
import { TransactionType } from '../transactions/enums/transaction-type.enum.js';
import { TransactionPurpose } from '../transactions/enums/transaction-purpose.enum.js';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum.js';
import { FxService } from '../fx/fx.service.js';
import { getSubunitFactor } from './utils/currency.util.js';
import { isSupportedCurrency } from '../common/constants/supported-currencies.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { LockService } from '../common/lock/lock.service.js';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly transactionsService: TransactionsService,
    private readonly lockService: LockService,
    private readonly dataSource: DataSource,
    private readonly fxService: FxService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /**
   * Fetches or creates a wallet for a user.
   * Uses cache-aside pattern for balances.
   */
  async getWallet(userId: string) {
    const cacheKey = `wallet:balances:${userId}`;
    
    // 1. Try Cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      // Fail silent and fallback to DB
    }

    // 2. Fallback to DB
    let wallet = await this.walletRepository.findOne({
      where: { userId },
    });

    if (!wallet) {
      wallet = this.walletRepository.create({ userId });
      wallet = await this.walletRepository.save(wallet);
      wallet.balances = [];
    }

    const result = {
      walletId: wallet.id,
      userId: wallet.userId,
      balances: wallet.balances,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };

    // 3. Populate Cache (1 hour TTL)
    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
    } catch (error) {
      // Fail silent
    }

    return result;
  }

  /**
   * Funds a wallet with a specified currency.
   */
  async fundWallet(userId: string, currency: string, amount: number, idempotencyKey: string) {
    const normalizedCurrency = currency.toUpperCase();

    if (!isSupportedCurrency(normalizedCurrency)) {
      throw new BadRequestException(`Unsupported currency: ${normalizedCurrency}`);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in smallest currency unit');
    }

    const existing = await this.transactionsService.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.status === TransactionStatus.SUCCESS) {
        return {
          message: 'Wallet funded successfully (idempotent)',
          currency: existing.currency,
          amount: Number(existing.amount),
          newBalance: Number(existing.balanceAfter),
        };
      }
      if (existing.status === TransactionStatus.PENDING) {
        throw new BadRequestException('Transaction is currently being processed. Please wait.');
      }
      if (existing.status === TransactionStatus.FAILED) {
        throw new BadRequestException('Transaction previously failed. Please use a new idempotency key.');
      }
    }

    //  Early Claim (PENDING status)
    return this.lockService.acquire(`wallet:${userId}`, 10000, async () => {
      let wallet = await this.walletRepository.findOne({ where: { userId } });
      if (!wallet) {
        wallet = this.walletRepository.create({ userId });
        wallet = await this.walletRepository.save(wallet);
      }

      const pendingLog = await this.transactionsService.recordTransaction({
        walletId: wallet.id,
        userId,
        type: TransactionType.CREDIT,
        purpose: TransactionPurpose.FUNDING,
        currency: normalizedCurrency,
        amount,
        balanceBefore: 0,
        balanceAfter: 0,
        idempotencyKey,
        status: TransactionStatus.PENDING,
      });

      //Fund logic
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

        // 4. Update log to SUCCESS
        await this.transactionsService.updateTransaction(
          pendingLog.id,
          {
            balanceBefore,
            balanceAfter,
            status: TransactionStatus.SUCCESS,
          },
          queryRunner.manager,
        );

        await queryRunner.commitTransaction();

        // Invalidate cache
        await this.redis.del(`wallet:balances:${userId}`).catch(() => {});

        return {
          message: 'Wallet funded successfully',
          status: TransactionStatus.SUCCESS,
          currency: normalizedCurrency,
          amount,
          newBalance: balanceAfter,
        };
      } catch (error) {
        await queryRunner.rollbackTransaction();
        await this.transactionsService.updateTransaction(pendingLog.id, {
          status: TransactionStatus.FAILED,
        });
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('Failed to fund wallet');
      } finally {
        await queryRunner.release();
      }
    });
  }

  /**
   * Converts funds between two currencies.
   */
  async convertFunds(
    userId: string,
    from: string,
    to: string,
    amount: number,
    idempotencyKey: string,
    context: 'convert' | 'trade' = 'convert',
  ) {
    const fromCurrency = from.toUpperCase();
    const toCurrency = to.toUpperCase();

    if (fromCurrency === toCurrency) {
      throw new BadRequestException('Cannot convert to the same currency');
    }

    if (!isSupportedCurrency(fromCurrency)) {
      throw new BadRequestException(`Unsupported currency: ${fromCurrency}`);
    }
    if (!isSupportedCurrency(toCurrency)) {
      throw new BadRequestException(`Unsupported currency: ${toCurrency}`);
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive integer in smallest currency unit');
    }

    const debitKey = `${idempotencyKey}:debit`;
    const creditKey = `${idempotencyKey}:credit`;

    // 1. Idempotency check
    const existingDebit = await this.transactionsService.findByIdempotencyKey(debitKey);
    if (existingDebit) {
      if (existingDebit.status === TransactionStatus.SUCCESS) {
        const existingCredit = await this.transactionsService.findByIdempotencyKey(creditKey);
        return {
          message: 'Conversion successful (idempotent)',
          status: existingDebit.status,
          exchangeRate: Number(existingDebit.exchangeRate),
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
    const exchangeRate = rates.rates[toCurrency] / rates.rates[fromCurrency];

    const fromFactor = getSubunitFactor(fromCurrency);
    const toFactor = getSubunitFactor(toCurrency);
    const majorAmount = amount / fromFactor;
    const convertedMajor = majorAmount * exchangeRate;
    const convertedAmount = Math.round(convertedMajor * toFactor);

    if (convertedAmount <= 0) {
      throw new BadRequestException(`Amount too small to ${context}.`);
    }

    // 2. Early Claim (PENDING status)
    return this.lockService.acquire(`wallet:${userId}`, 10000, async () => {
      let wallet = await this.walletRepository.findOne({ where: { userId } });
      if (!wallet) {
        wallet = this.walletRepository.create({ userId });
        wallet = await this.walletRepository.save(wallet);
      }

      const pendingDebit = await this.transactionsService.recordTransaction({
        walletId: wallet.id,
        userId,
        type: TransactionType.DEBIT,
        purpose: context === 'trade' ? TransactionPurpose.TRADE : TransactionPurpose.EXCHANGE,
        currency: fromCurrency,
        amount,
        balanceBefore: 0,
        balanceAfter: 0,
        exchangeRate,
        idempotencyKey: debitKey,
        status: TransactionStatus.PENDING,
      });

      const pendingCredit = await this.transactionsService.recordTransaction({
        walletId: wallet.id,
        userId,
        type: TransactionType.CREDIT,
        purpose: context === 'trade' ? TransactionPurpose.TRADE : TransactionPurpose.EXCHANGE,
        currency: toCurrency,
        amount: convertedAmount,
        balanceBefore: 0,
        balanceAfter: 0,
        exchangeRate,
        idempotencyKey: creditKey,
        status: TransactionStatus.PENDING,
      });

      // 3. Execution logic
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const fromBalance = await queryRunner.manager
          .createQueryBuilder(Balance, 'balance')
          .setLock('pessimistic_write')
          .where('balance.walletId = :walletId AND balance.currency = :currency', {
            walletId: wallet.id,
            currency: fromCurrency,
          })
          .getOne();

        if (!fromBalance || Number(fromBalance.amount) < amount) {
          throw new BadRequestException(`Insufficient ${fromCurrency} balance`);
        }

        let toBalance = await queryRunner.manager
          .createQueryBuilder(Balance, 'balance')
          .setLock('pessimistic_write')
          .where('balance.walletId = :walletId AND balance.currency = :currency', {
            walletId: wallet.id,
            currency: toCurrency,
          })
          .getOne();

        if (!toBalance) {
          toBalance = queryRunner.manager.create(Balance, {
            walletId: wallet.id,
            currency: toCurrency,
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

        // 4. Update logs to SUCCESS
        await this.transactionsService.updateTransaction(
          pendingDebit.id,
          { balanceBefore: fromBefore, balanceAfter: fromAfter, status: TransactionStatus.SUCCESS },
          queryRunner.manager,
        );

        await this.transactionsService.updateTransaction(
          pendingCredit.id,
          { balanceBefore: toBefore, balanceAfter: toAfter, status: TransactionStatus.SUCCESS },
          queryRunner.manager,
        );

        await queryRunner.commitTransaction();

        // Invalidate cache
        await this.redis.del(`wallet:balances:${userId}`).catch(() => {});

        return {
          message: 'Conversion successful',
          status: TransactionStatus.SUCCESS,
          rateVersion: rates.version,
          exchangeRate,
          debit: { ...pendingDebit, balanceBefore: fromBefore, balanceAfter: fromAfter, status: TransactionStatus.SUCCESS },
          credit: { ...pendingCredit, balanceBefore: toBefore, balanceAfter: toAfter, status: TransactionStatus.SUCCESS },
        };
      } catch (error) {
        await queryRunner.rollbackTransaction();
        await this.transactionsService.updateTransaction(pendingDebit.id, { status: TransactionStatus.FAILED });
        await this.transactionsService.updateTransaction(pendingCredit.id, { status: TransactionStatus.FAILED });
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('Failed to convert funds');
      } finally {
        await queryRunner.release();
      }
    });
  }

  /**
   * Alias for convertFunds with 'trade' context.
   */
  async tradeFunds(
    userId: string,
    fromCurrency: string,
    toCurrency: string,
    amount: number,
    idempotencyKey: string,
  ) {
    return this.convertFunds(userId, fromCurrency, toCurrency, amount, idempotencyKey, 'trade');
  }
}
