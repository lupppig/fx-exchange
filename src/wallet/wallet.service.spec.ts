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
            findOneOrFail: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
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
      expect(result.status).toBe(TransactionStatus.SUCCESS);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should fail if transaction is PENDING', async () => {
      const log = { id: 'log-1', status: TransactionStatus.PENDING };
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(log as TransactionLog);

      await expect(service.fundWallet(mockUserId, 'NGN', 100000, 'idem-key'))
        .rejects.toThrow('Transaction is currently being processed. Please wait.');
    });

    it('should successfully fund wallet with state transitions', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValueOnce(null); // check
      jest.spyOn(transactionLogRepo, 'findOneOrFail').mockResolvedValueOnce({ id: 'log-1', status: TransactionStatus.SUCCESS } as any); // final

      const wallet = { id: mockWalletId, userId: mockUserId };
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue(wallet as any);

      jest.spyOn(transactionLogRepo, 'create').mockReturnValue({ id: 'log-pending' } as any);
      jest.spyOn(transactionLogRepo, 'save').mockResolvedValue({ id: 'log-pending' } as any);
      jest.spyOn(transactionLogRepo, 'update').mockResolvedValue({} as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);
      jest.spyOn(manager, 'create').mockImplementation((_entity: any, props: any) => props);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => obj);

      const result = await service.fundWallet(mockUserId, 'NGN', 50000, 'idem-key');

      expect(transactionLogRepo.save).toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(TransactionLog, 'log-pending', expect.objectContaining({ status: TransactionStatus.SUCCESS }));
      expect(result.message).toBe('Wallet funded successfully');
      expect(result.status).toBe(TransactionStatus.SUCCESS);
    });

    it('should update status to FAILED on error', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(null);
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue({ id: mockWalletId } as any);
      jest.spyOn(transactionLogRepo, 'create').mockReturnValue({ id: 'log-pending' } as any);
      jest.spyOn(transactionLogRepo, 'save').mockResolvedValue({ id: 'log-pending' } as any);
      jest.spyOn(transactionLogRepo, 'update').mockResolvedValue({} as any);

      jest.spyOn(manager, 'createQueryBuilder').mockImplementation(() => {
        throw new Error('DB Error');
      });

      await expect(service.fundWallet(mockUserId, 'NGN', 10000, 'idem-key')).rejects.toThrow(BadRequestException);

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(transactionLogRepo.update).toHaveBeenCalledWith('log-pending', { status: TransactionStatus.FAILED });
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('convertFunds', () => {
    it('should return for already processed idempotent conversion', async () => {
      const log = { id: 'log-1', status: TransactionStatus.SUCCESS };
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValue(log as TransactionLog);

      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 100000, 'idem-key');

      expect(result.message).toBe('Conversion already processed');
      expect(result.status).toBe(TransactionStatus.SUCCESS);
    });

    it('should successfully convert with state machine', async () => {
      jest.spyOn(transactionLogRepo, 'findOne').mockResolvedValueOnce(null);
      jest.spyOn(transactionLogRepo, 'findOneOrFail')
        .mockResolvedValueOnce({ id: 'log-debit', status: TransactionStatus.SUCCESS } as any)
        .mockResolvedValueOnce({ id: 'log-credit', status: TransactionStatus.SUCCESS } as any);

      jest.spyOn(fxService, 'getRates').mockResolvedValue({
        version: 'v1',
        base: 'NGN',
        timestamp: new Date().toISOString(),
        rates: { NGN: 1, USD: 0.0006 },
      });

      jest.spyOn(walletRepo, 'findOne').mockResolvedValue({ id: mockWalletId } as any);
      
      // Distinct IDs for debit and credit
      jest.spyOn(transactionLogRepo, 'create')
        .mockReturnValueOnce({ id: 'log-debit' } as any)
        .mockReturnValueOnce({ id: 'log-credit' } as any);
      
      jest.spyOn(transactionLogRepo, 'save').mockImplementation(async (obj: any) => obj);
      jest.spyOn(transactionLogRepo, 'update').mockResolvedValue({} as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn()
          .mockResolvedValueOnce({ id: 'bal-ngn', currency: 'NGN', amount: 500000 })
          .mockResolvedValueOnce({ id: 'bal-usd', currency: 'USD', amount: 0 }),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => obj);

      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 200000, 'idem-key');

      expect(transactionLogRepo.save).toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(TransactionLog, 'log-debit', expect.objectContaining({ status: TransactionStatus.SUCCESS }));
      expect(manager.update).toHaveBeenCalledWith(TransactionLog, 'log-credit', expect.objectContaining({ status: TransactionStatus.SUCCESS }));
      expect(result.message).toBe('Conversion successful');
      expect(result.status).toBe(TransactionStatus.SUCCESS);
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

  describe('tradeFunds', () => {
    it('should show "trade" in error message when using tradeFunds', async () => {
      jest.spyOn(fxService, 'getRates').mockResolvedValue({
        rates: { NGN: 1, USD: 0.0006 },
      } as any);

      // 500 NGN kobo = 5 NGN * 0.0006 = 0.003 USD = 0.3 cents -> 0
      await expect(
        service.tradeFunds(mockUserId, 'NGN', 'USD', 500, 'idem-key'),
      ).rejects.toThrow('Amount too small to trade.');
    });
  });
});
