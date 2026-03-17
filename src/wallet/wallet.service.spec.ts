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
    // Mock QueryRunner and Manager
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
      expect(walletRepo.findOne).toHaveBeenCalledWith({ where: { userId: mockUserId } });
    });

    it('should create new wallet if not found', async () => {
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue(null);
      const newWallet = { id: mockWalletId, userId: mockUserId, balances: [] };
      jest.spyOn(walletRepo, 'create').mockReturnValue(newWallet as unknown as Wallet);
      jest.spyOn(walletRepo, 'save').mockResolvedValue(newWallet as unknown as Wallet);

      const result = await service.getWallet(mockUserId);

      expect(result.walletId).toBe(mockWalletId);
      expect(walletRepo.create).toHaveBeenCalledWith({ userId: mockUserId });
      expect(walletRepo.save).toHaveBeenCalled();
    });
  });

  describe('fundWallet', () => {
    it('should return gracefully for processed idempotent transaction', async () => {
      const log = { id: 'log-1', status: TransactionStatus.SUCCESS };
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(log as TransactionLog);

      const result = await service.fundWallet(mockUserId, 'NGN', 100, 'idem-key');

      expect(result.message).toBe('Transaction already processed');
      expect(result.transaction).toEqual(log);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should successfully fund wallet and log transaction', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);

      const wallet = { id: mockWalletId, userId: mockUserId };
      jest.spyOn(manager, 'findOne').mockResolvedValue(wallet as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null), // No balance exists yet
      } as unknown as SelectQueryBuilder<Balance>;
      
      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);

      jest.spyOn(manager, 'create').mockImplementation((_entity: any, props: any) => props);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => {
        if (obj.currency) return { ...obj, id: 'bal-1' }; // Balance
        return { ...obj, id: 'log-1' }; // TxLog
      });

      const result = await service.fundWallet(mockUserId, 'NGN', 500, 'idem-key');

      expect(queryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(manager.update).toHaveBeenCalledWith(Balance, 'bal-1', { amount: 500 });
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
      expect(result.message).toBe('Wallet funded successfully');
      expect(result.transaction.balanceAfter).toBe(500);
      expect(result.transaction.amount).toBe(500);
    });

    it('should rollback transaction on error', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);
      jest.spyOn(manager, 'findOne').mockRejectedValue(new Error('DB Error'));

      await expect(service.fundWallet(mockUserId, 'NGN', 100, 'idem-key')).rejects.toThrow(BadRequestException);

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('convertFunds', () => {
    it('should quickly return for an already processed idempotent conversion', async () => {
      const log = { id: 'log-1', status: TransactionStatus.SUCCESS };
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(log as TransactionLog);

      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 1000, 'idem-key');

      expect(result.message).toBe('Conversion already processed');
      expect(result.debit).toEqual(log);
      expect(result.credit).toEqual(log);
      expect(fxService.getRates).not.toHaveBeenCalled();
    });

    it('should fail if converting identical currencies', async () => {
      await expect(
        service.convertFunds(mockUserId, 'NGN', 'NGN', 1000, 'idem-key'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should successfully convert and perform double-entry logging', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);

      jest.spyOn(fxService, 'getRates').mockResolvedValue({
        version: 'v1',
        base: 'NGN',
        timestamp: new Date().toISOString(),
        rates: { NGN: 1, USD: 0.0006 },
      });

      const wallet = { id: mockWalletId, userId: mockUserId };

      jest.spyOn(manager, 'findOne').mockResolvedValueOnce(wallet as any);

      // We need to mock the query builder to return the NGN balance on first call, null on second (USD)
      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn()
          .mockResolvedValueOnce({ id: 'bal-ngn', currency: 'NGN', amount: 5000 })
          .mockResolvedValueOnce(null),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);

      jest.spyOn(manager, 'create').mockImplementation((_entity: any, props: any) => props);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => {
        if (obj.currency === 'USD') return { ...obj, id: 'bal-usd' };
        return { ...obj, id: `log-${Math.random()}` };
      });

      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 2000, 'idem-key');

      expect(queryRunner.startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
      expect(manager.update).toHaveBeenCalledWith(Balance, 'bal-ngn', { amount: 3000 });
      // 2000 * 0.0006 = 1.2
      expect(manager.update).toHaveBeenCalledWith(Balance, 'bal-usd', { amount: 1.2 });
      expect(queryRunner.commitTransaction).toHaveBeenCalled();

      expect(result.message).toBe('Conversion successful');
      expect(result.debit!.currency).toBe('NGN');
      expect(result.debit!.amount).toBe(2000);
      expect(result.credit!.currency).toBe('USD');
      expect(result.credit!.amount).toBe(1.2);
    });

    it('should throw an error if the user has insufficient funds', async () => {
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
        getOne: jest.fn().mockResolvedValueOnce({ id: 'bal-ngn', currency: 'NGN', amount: 500 }),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);

      await expect(
        service.convertFunds(mockUserId, 'NGN', 'USD', 2000, 'idem-key'),
      ).rejects.toThrow(BadRequestException);

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });
});

