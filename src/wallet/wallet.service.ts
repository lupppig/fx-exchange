import { plainToInstance } from 'class-transformer';
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { DataSource, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { Balance } from './entities/balance.entity';
import { TransactionType } from '../transactions/enums/transaction-type.enum';
import { TransactionPurpose } from '../transactions/enums/transaction-purpose.enum';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum';
import { FxService } from '../fx/fx.service';
import { convertSubunits, crossRate, parseRate } from './utils/money';
import { isSupportedCurrency } from '../common/constants/supported-currencies';
import { JournalEntry } from '../transactions/entities/journal-entry.entity';
import { TransactionsService } from '../transactions/transactions.service';
import { LockService } from '../common/lock/lock.service';
import { WalletResponseDto } from './dto/wallet-response.dto';
import { HouseAccountService, HOUSE_USER_ID } from './house-account.service';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly transactionsService: TransactionsService,
    private readonly lockService: LockService,
    private readonly dataSource: DataSource,
    private readonly fxService: FxService,
    private readonly houseAccount: HouseAccountService,
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
    } catch (error) {
      this.logger.warn({
        message: 'Failed to read wallet cache',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
    } catch (error) {
      this.logger.warn({
        message: 'Failed to cache wallet',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

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

    return this.lockService.acquire(`wallet:${userId}`, async () => {
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

        const balanceAfter = balanceBefore + amount;

        // House is the counterparty: it loses the currency it pays out to
        // the user. Lock the house row second to keep a consistent lock
        // ordering (user-wallet before house-wallet) across all flows --
        // this avoids cross-flow deadlocks.
        const houseBalance = await this.houseAccount.lockBalance(
          queryRunner,
          normalizedCurrency,
        );
        const houseBefore = Number(houseBalance.amount);
        const houseAfter = houseBefore - amount;
        if (houseAfter < 0) {
          throw new BadRequestException(
            `House liquidity exhausted for ${normalizedCurrency}`,
          );
        }

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
                walletId: houseBalance.walletId,
                userId: HOUSE_USER_ID,
                type: TransactionType.DEBIT,
                currency: normalizedCurrency,
                amount,
                balanceBefore: houseBefore,
                balanceAfter: houseAfter,
              },
            ],
          },
          queryRunner,
        );

        await queryRunner.manager.update(Balance, balance.id, {
          amount: balanceAfter,
        });
        await queryRunner.manager.update(Balance, houseBalance.id, {
          amount: houseAfter,
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

    return this.lockService.acquire(`wallet:${userId}`, async () => {
      const rates = await this.fxService.getRates();

      // Cross rate computed via Decimal -- no IEEE 754 loss between the
      // upstream provider quote and the final subunit rounding step.
      const exchangeRateDecimal = crossRate(
        parseRate(rates.rates[fromCurrency]),
        parseRate(rates.rates[toCurrency]),
      );
      const exchangeRate = Number(exchangeRateDecimal.toFixed(8));

      const convertedAmount = Number(
        convertSubunits(
          BigInt(amount),
          fromCurrency,
          toCurrency,
          exchangeRateDecimal,
        ),
      );

      if (convertedAmount <= 0) {
        throw new BadRequestException(`Amount too small to ${context}.`);
      }

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
        const fromAfter = fromBefore - amount;
        const toBefore = Number(toBalance.amount);
        const toAfter = toBefore + convertedAmount;

        // House counterparty legs. Locking order: user-from, user-to,
        // house-from, house-to. House is always locked after the user to
        // avoid deadlocks with other concurrent flows.
        const houseFrom = await this.houseAccount.lockBalance(
          queryRunner,
          fromCurrency,
        );
        const houseTo = await this.houseAccount.lockBalance(
          queryRunner,
          toCurrency,
        );
        const houseFromBefore = Number(houseFrom.amount);
        const houseFromAfter = houseFromBefore + amount; // house takes in `from`
        const houseToBefore = Number(houseTo.amount);
        const houseToAfter = houseToBefore - convertedAmount; // house pays out `to`
        if (houseToAfter < 0) {
          throw new BadRequestException(
            `House liquidity exhausted for ${toCurrency}`,
          );
        }

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
                walletId: houseFrom.walletId,
                userId: HOUSE_USER_ID,
                type: TransactionType.CREDIT,
                currency: fromCurrency,
                amount,
                balanceBefore: houseFromBefore,
                balanceAfter: houseFromAfter,
              },
              {
                walletId: houseTo.walletId,
                userId: HOUSE_USER_ID,
                type: TransactionType.DEBIT,
                currency: toCurrency,
                amount: convertedAmount,
                balanceBefore: houseToBefore,
                balanceAfter: houseToAfter,
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
        await queryRunner.manager.update(Balance, houseFrom.id, {
          amount: houseFromAfter,
        });
        await queryRunner.manager.update(Balance, houseTo.id, {
          amount: houseToAfter,
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
