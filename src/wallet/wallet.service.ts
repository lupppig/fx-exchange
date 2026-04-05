import { plainToInstance } from 'class-transformer';
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
import { JournalEntry } from '../transactions/entities/journal-entry.entity.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { LockService } from '../common/lock/lock.service.js';
import { WalletResponseDto } from './dto/wallet-response.dto.js';

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

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return plainToInstance(WalletResponseDto, JSON.parse(cached));
      }
    } catch (error) {}

    let wallet = await this.walletRepository.findOne({
      where: { userId },
      relations: ['balances'],
    });

    if (!wallet) {
      wallet = this.walletRepository.create({ userId });
      wallet = await this.walletRepository.save(wallet);
      wallet.balances = [];
    }

    const result = plainToInstance(WalletResponseDto, {
      walletId: wallet.id,
      userId: wallet.userId,
      balances: wallet.balances,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
    } catch (error) {}

    return result;
  }

  /**
   * Funds a wallet with a specified currency.
   * Creates a proper double-entry journal:
   *   CREDIT to user balance
   *   DEBIT from external funding source
   * All within a single atomic transaction.
   */
  async fundWallet(
    userId: string,
    currency: string,
    amount: number,
    idempotencyKey: string,
  ) {
    const normalizedCurrency = currency.toUpperCase();

    if (!isSupportedCurrency(normalizedCurrency)) {
      throw new BadRequestException(
        `Unsupported currency: ${normalizedCurrency}`,
      );
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(
        'Amount must be a positive integer in smallest currency unit',
      );
    }

    const existing = await this.transactionsService.findByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (existing) {
      if (existing.status === TransactionStatus.SUCCESS) {
        return {
          message: 'Wallet funded successfully (idempotent)',
          status: TransactionStatus.SUCCESS,
          journal: plainToInstance(JournalEntry, existing),
        };
      }
      if (existing.status === TransactionStatus.PENDING) {
        throw new BadRequestException(
          'Transaction is currently being processed. Please wait.',
        );
      }
      if (existing.status === TransactionStatus.FAILED) {
        throw new BadRequestException(
          'Transaction previously failed. Please use a new idempotency key.',
        );
      }
    }

    return this.lockService.acquire(`wallet:${userId}`, 10000, async () => {
      let wallet = await this.walletRepository.findOne({ where: { userId } });
      if (!wallet) {
        wallet = this.walletRepository.create({ userId });
        wallet = await this.walletRepository.save(wallet);
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        let balance = await queryRunner.manager
          .createQueryBuilder(Balance, 'balance')
          .setLock('pessimistic_write')
          .where(
            'balance.walletId = :walletId AND balance.currency = :currency',
            {
              walletId: wallet.id,
              currency: normalizedCurrency,
            },
          )
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

        const balanceAfter = Number(balanceBefore) + Number(amount);

        // Create journal entry atomically with balance update
        const journal = await this.transactionsService.recordJournalEntry(
          {
            walletId: wallet.id,
            userId,
            purpose: TransactionPurpose.FUNDING,
            idempotencyKey,
            status: TransactionStatus.SUCCESS,
            entries: [
              {
                walletId: wallet.id,
                userId,
                type: TransactionType.CREDIT,
                currency: normalizedCurrency,
                amount,
                balanceBefore,
                balanceAfter,
              },
              {
                walletId: wallet.id,
                userId,
                type: TransactionType.DEBIT,
                currency: normalizedCurrency,
                amount,
                balanceBefore: 0,
                balanceAfter: 0,
              },
            ],
          },
          queryRunner,
        );

        await queryRunner.manager.update(Balance, balance.id, {
          amount: balanceAfter,
        });

        await queryRunner.commitTransaction();

        await this.redis.del(`wallet:balances:${userId}`).catch(() => {});

        return {
          message: 'Wallet funded successfully',
          status: TransactionStatus.SUCCESS,
          journal,
        };
      } catch (error) {
        await queryRunner.rollbackTransaction();
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('Failed to fund wallet');
      } finally {
        await queryRunner.release();
      }
    });
  }

  /**
   * Converts funds between two currencies.
   * Creates a journal entry with a DEBIT + CREDIT ledger entry pair.
   * All within a single atomic transaction.
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
      throw new BadRequestException(
        'Amount must be a positive integer in smallest currency unit',
      );
    }

    const existing = await this.transactionsService.findByIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (existing) {
      if (existing.status === TransactionStatus.SUCCESS) {
        return {
          message: 'Conversion successful (idempotent)',
          status: existing.status,
          exchangeRate: Number(existing.exchangeRate),
          journal: plainToInstance(JournalEntry, existing),
        };
      }
      if (existing.status === TransactionStatus.PENDING) {
        throw new BadRequestException(
          'Conversion is currently being processed. Please wait.',
        );
      }
      if (existing.status === TransactionStatus.FAILED) {
        throw new BadRequestException(
          'Conversion previously failed. Please use a new idempotency key.',
        );
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

    return this.lockService.acquire(`wallet:${userId}`, 10000, async () => {
      let wallet = await this.walletRepository.findOne({ where: { userId } });
      if (!wallet) {
        wallet = this.walletRepository.create({ userId });
        wallet = await this.walletRepository.save(wallet);
      }

      const purpose =
        context === 'trade'
          ? TransactionPurpose.TRADE
          : TransactionPurpose.EXCHANGE;

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const fromBalance = await queryRunner.manager
          .createQueryBuilder(Balance, 'balance')
          .setLock('pessimistic_write')
          .where(
            'balance.walletId = :walletId AND balance.currency = :currency',
            {
              walletId: wallet.id,
              currency: fromCurrency,
            },
          )
          .getOne();

        if (!fromBalance || Number(fromBalance.amount) < amount) {
          throw new BadRequestException(`Insufficient ${fromCurrency} balance`);
        }

        let toBalance = await queryRunner.manager
          .createQueryBuilder(Balance, 'balance')
          .setLock('pessimistic_write')
          .where(
            'balance.walletId = :walletId AND balance.currency = :currency',
            {
              walletId: wallet.id,
              currency: toCurrency,
            },
          )
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
        const fromAfter = Number(fromBefore) - Number(amount);
        const toBefore = Number(toBalance.amount);
        const toAfter = Number(toBefore) + Number(convertedAmount);

        // Create journal entry atomically with balance updates
        const journal = await this.transactionsService.recordJournalEntry(
          {
            walletId: wallet.id,
            userId,
            purpose,
            idempotencyKey,
            exchangeRate,
            status: TransactionStatus.SUCCESS,
            entries: [
              {
                walletId: wallet.id,
                userId,
                type: TransactionType.DEBIT,
                currency: fromCurrency,
                amount,
                balanceBefore: fromBefore,
                balanceAfter: fromAfter,
              },
              {
                walletId: wallet.id,
                userId,
                type: TransactionType.CREDIT,
                currency: toCurrency,
                amount: convertedAmount,
                balanceBefore: toBefore,
                balanceAfter: toAfter,
              },
            ],
          },
          queryRunner,
        );

        await queryRunner.manager.update(Balance, fromBalance.id, {
          amount: fromAfter,
        });
        await queryRunner.manager.update(Balance, toBalance.id, {
          amount: toAfter,
        });

        await queryRunner.commitTransaction();

        await this.redis.del(`wallet:balances:${userId}`).catch(() => {});

        return {
          message: 'Conversion successful',
          status: TransactionStatus.SUCCESS,
          rateVersion: rates.version,
          exchangeRate,
          journal,
        };
      } catch (error) {
        await queryRunner.rollbackTransaction();
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
    return this.convertFunds(
      userId,
      fromCurrency,
      toCurrency,
      amount,
      idempotencyKey,
      'trade',
    );
  }
}
