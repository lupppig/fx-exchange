import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity.js';
import { Balance } from './entities/balance.entity.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(TransactionLog)
    private readonly transactionLogRepository: Repository<TransactionLog>,
    private readonly dataSource: DataSource,
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
        type: TransactionType.CREDIT,
        purpose: TransactionPurpose.FUNDING,
        currency: normalizedCurrency,
        amount,
        balanceBefore,
        balanceAfter,
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
}
