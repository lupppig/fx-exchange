import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DataSource, Repository, EntityManager, QueryRunner, SelectQueryBuilder } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WalletService } from './wallet.service.js';
import { Wallet } from './entities/wallet.entity.js';
import { Balance } from './entities/balance.entity.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';
import { FxService } from '../fx/fx.service.js';

describe('WalletService', () => {
  let service: WalletService;
  let walletRepo: Repository<Wallet>;
  let transactionLogRepo: Repository<TransactionLog>;
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let manager: EntityManager;
  let fxService: FxService;

  const mockUserId = 'user-123';
  const mockWalletId = 'wallet-123';

  beforeEach(async () => {
    manager = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as EntityManager;

    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager,
    } as unknown as QueryRunner;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: getRepositoryToken(Wallet),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(TransactionLog),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue(queryRunner),
          },
        },
        {
          provide: FxService,
          useValue: {
            getRates: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    walletRepo = module.get<Repository<Wallet>>(getRepositoryToken(Wallet));
    transactionLogRepo = module.get<Repository<TransactionLog>>(getRepositoryToken(TransactionLog));
    dataSource = module.get<DataSource>(DataSource);
    fxService = module.get<FxService>(FxService);
  });

  describe('getWallet', () => {
    it('should return existing wallet', async () => {
      const mockWallet = { id: mockWalletId, userId: mockUserId, balances: [] };
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue(mockWallet as unknown as Wallet);

      const result = await service.getWallet(mockUserId);

      expect(result).toEqual({
        walletId: mockWalletId,
        userId: mockUserId,
        balances: [],
        createdAt: undefined,
        updatedAt: undefined,
      });
    });

    it('should create new wallet if not found', async () => {
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue(null);
      const newWallet = { id: mockWalletId, userId: mockUserId, balances: [] };
      jest.spyOn(walletRepo, 'create').mockReturnValue(newWallet as unknown as Wallet);
      jest.spyOn(walletRepo, 'save').mockResolvedValue(newWallet as unknown as Wallet);

      const result = await service.getWallet(mockUserId);

      expect(result.walletId).toBe(mockWalletId);
      expect(walletRepo.create).toHaveBeenCalledWith({ userId: mockUserId });
    });
  });

  describe('fundWallet', () => {
    it('should return gracefully for processed idempotent transaction', async () => {
      const log = { id: 'log-1', status: TransactionStatus.SUCCESS };
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(log as TransactionLog);

      const result = await service.fundWallet(mockUserId, 'NGN', 100000, 'idem-key');

      expect(result.message).toBe('Transaction already processed');
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should successfully fund wallet with integer amount', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);

      const wallet = { id: mockWalletId, userId: mockUserId };
      jest.spyOn(manager, 'findOne').mockResolvedValue(wallet as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);
      jest.spyOn(manager, 'create').mockImplementation((_entity: any, props: any) => props);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => {
        if (obj.currency) return { ...obj, id: 'bal-1' };
        return { ...obj, id: 'log-1' };
      });

      // Fund 50000 kobo (500 NGN)
      const result = await service.fundWallet(mockUserId, 'NGN', 50000, 'idem-key');

      expect(queryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(manager.update).toHaveBeenCalledWith(Balance, 'bal-1', { amount: 50000 });
      expect(result.message).toBe('Wallet funded successfully');
      expect(result.transaction.balanceAfter).toBe(50000);
      expect(result.transaction.amount).toBe(50000);
      expect(result.transaction.userId).toBe(mockUserId);
      expect(result.transaction.exchangeRate).toBeNull();
    });

    it('should rollback transaction on error', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);
      jest.spyOn(manager, 'findOne').mockRejectedValue(new Error('DB Error'));

      await expect(service.fundWallet(mockUserId, 'NGN', 10000, 'idem-key')).rejects.toThrow(BadRequestException);

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('convertFunds', () => {
    it('should return for already processed idempotent conversion', async () => {
      const log = { id: 'log-1', status: TransactionStatus.SUCCESS };
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(log as TransactionLog);

      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 100000, 'idem-key');

      expect(result.message).toBe('Conversion already processed');
      expect(fxService.getRates).not.toHaveBeenCalled();
    });

    it('should fail if converting identical currencies', async () => {
      await expect(
        service.convertFunds(mockUserId, 'NGN', 'NGN', 100000, 'idem-key'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should convert using integer subunits and record exchangeRate', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);

      // NGN base: NGN=1, USD=0.0006
      jest.spyOn(fxService, 'getRates').mockResolvedValue({
        version: 'v1',
        base: 'NGN',
        timestamp: new Date().toISOString(),
        rates: { NGN: 1, USD: 0.0006 },
      });

      const wallet = { id: mockWalletId, userId: mockUserId };
      jest.spyOn(manager, 'findOne').mockResolvedValueOnce(wallet as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn()
          // NGN balance: 500000 kobo (5000 NGN)
          .mockResolvedValueOnce({ id: 'bal-ngn', currency: 'NGN', amount: 500000 })
          // No USD balance
          .mockResolvedValueOnce(null),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);
      jest.spyOn(manager, 'create').mockImplementation((_entity: any, props: any) => props);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => {
        if (obj.currency === 'USD') return { ...obj, id: 'bal-usd' };
        return { ...obj, id: `log-${Math.random()}` };
      });

      // Convert 200000 kobo (2000 NGN) to USD
      // 2000 NGN * 0.0006 = 1.20 USD = 120 cents
      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 200000, 'idem-key');

      expect(manager.update).toHaveBeenCalledWith(Balance, 'bal-ngn', { amount: 300000 });
      expect(manager.update).toHaveBeenCalledWith(Balance, 'bal-usd', { amount: 120 });
      expect(result.message).toBe('Conversion successful');
      expect(result.exchangeRate).toBe(0.0006);
      expect(result.debit.amount).toBe(200000);
      expect(result.debit.userId).toBe(mockUserId);
      expect(result.credit!.amount).toBe(120);
    });

    it('should throw if insufficient balance', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);

      jest.spyOn(fxService, 'getRates').mockResolvedValue({
        version: 'v1',
        base: 'NGN',
        timestamp: new Date().toISOString(),
        rates: { NGN: 1, USD: 0.0006 },
      });

      const wallet = { id: mockWalletId, userId: mockUserId };
      jest.spyOn(manager, 'findOne').mockResolvedValueOnce(wallet as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValueOnce({ id: 'bal-ngn', currency: 'NGN', amount: 5000 }),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);

      await expect(
        service.convertFunds(mockUserId, 'NGN', 'USD', 200000, 'idem-key'),
      ).rejects.toThrow(BadRequestException);

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('getTransactions', () => {
    it('should return first page of transactions', async () => {
      const mockTxs = Array.from({ length: 3 }, (_, i) => ({
        id: `tx-${i}`,
        createdAt: new Date(`2026-03-${17 - i}T12:00:00Z`),
      }));

      jest.spyOn(transactionLogRepo, 'find').mockResolvedValue(mockTxs as any);

      const result = await service.getTransactions(mockUserId, undefined, 20);

      expect(result.transactions).toHaveLength(3);
      expect(result.nextCursor).toBeNull();
      expect(result.count).toBe(3);
    });

    it('should return nextCursor when more pages exist', async () => {
      // Return limit + 1 items to trigger pagination
      const mockTxs = Array.from({ length: 3 }, (_, i) => ({
        id: `tx-${i}`,
        createdAt: new Date(`2026-03-${17 - i}T12:00:00Z`),
      }));

      jest.spyOn(transactionLogRepo, 'find').mockResolvedValue(mockTxs as any);

      const result = await service.getTransactions(mockUserId, undefined, 2);

      expect(result.transactions).toHaveLength(2);
      expect(result.nextCursor).toBe(new Date('2026-03-16T12:00:00Z').toISOString());
      expect(result.count).toBe(2);
    });

    it('should throw on invalid cursor format', async () => {
      await expect(
        service.getTransactions(mockUserId, 'not-a-date'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
