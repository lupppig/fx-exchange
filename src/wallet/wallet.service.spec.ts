import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository, EntityManager, QueryRunner, SelectQueryBuilder } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WalletService } from './wallet.service.js';
import { Wallet } from './entities/wallet.entity.js';
import { Balance } from './entities/balance.entity.js';
import { TransactionStatus } from '../transactions/enums/transaction-status.enum.js';
import { FxService } from '../fx/fx.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';

describe('WalletService', () => {
  let service: WalletService;
  let walletRepo: Repository<Wallet>;
  let transactionsService: TransactionsService;
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
      getRepository: jest.fn(),
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
          provide: getRepositoryToken(Balance),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: TransactionsService,
          useValue: {
            recordTransaction: jest.fn(),
            updateTransaction: jest.fn(),
            findByIdempotencyKey: jest.fn(),
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
    transactionsService = module.get<TransactionsService>(TransactionsService);
    dataSource = module.get<DataSource>(DataSource);
    fxService = module.get<FxService>(FxService);
  });

  describe('getWallet', () => {
    it('should return existing wallet', async () => {
      const mockWallet = { id: mockWalletId, userId: mockUserId, balances: [] };
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue(mockWallet as unknown as Wallet);

      const result = await service.getWallet(mockUserId);

      expect(result.walletId).toBe(mockWalletId);
      expect(result.userId).toBe(mockUserId);
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
      const log = { id: 'log-1', status: TransactionStatus.SUCCESS, currency: 'NGN', amount: 100000, balanceAfter: 200000 };
      jest.spyOn(transactionsService, 'findByIdempotencyKey').mockResolvedValue(log as any);

      const result = await service.fundWallet(mockUserId, 'NGN', 100000, 'idem-key');

      expect(result.message).toContain('idempotent');
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should fail if transaction is PENDING', async () => {
      const log = { id: 'log-1', status: TransactionStatus.PENDING };
      jest.spyOn(transactionsService, 'findByIdempotencyKey').mockResolvedValue(log as any);

      await expect(service.fundWallet(mockUserId, 'NGN', 100000, 'idem-key'))
        .rejects.toThrow('Transaction is currently being processed');
    });

    it('should successfully fund wallet with state transitions', async () => {
      jest.spyOn(transactionsService, 'findByIdempotencyKey').mockResolvedValue(null);
      jest.spyOn(transactionsService, 'recordTransaction').mockResolvedValue({ id: 'log-pending' } as any);
      
      const wallet = { id: mockWalletId, userId: mockUserId };
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue(wallet as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);
      jest.spyOn(manager, 'create').mockImplementation((_entity: any, props: any) => props);
      jest.spyOn(manager, 'save').mockImplementation(async (obj: any) => obj);

      const result = await service.fundWallet(mockUserId, 'NGN', 50000, 'idem-key');

      expect(transactionsService.recordTransaction).toHaveBeenCalled();
      expect(transactionsService.updateTransaction).toHaveBeenCalledWith('log-pending', expect.objectContaining({ status: TransactionStatus.SUCCESS }), expect.anything());
      expect(result.message).toBe('Wallet funded successfully');
    });

    it('should update status to FAILED on error', async () => {
      jest.spyOn(transactionsService, 'findByIdempotencyKey').mockResolvedValue(null);
      jest.spyOn(walletRepo, 'findOne').mockResolvedValue({ id: mockWalletId } as any);
      jest.spyOn(transactionsService, 'recordTransaction').mockResolvedValue({ id: 'log-pending' } as any);

      jest.spyOn(manager, 'createQueryBuilder').mockImplementation(() => {
        throw new Error('DB Error');
      });

      await expect(service.fundWallet(mockUserId, 'NGN', 10000, 'idem-key')).rejects.toThrow();

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(transactionsService.updateTransaction).toHaveBeenCalledWith('log-pending', { status: TransactionStatus.FAILED });
    });
  });

  describe('convertFunds', () => {
    it('should successfully convert within a transaction', async () => {
      jest.spyOn(transactionsService, 'findByIdempotencyKey').mockResolvedValue(null);
      jest.spyOn(transactionsService, 'recordTransaction')
        .mockResolvedValueOnce({ id: 'log-debit' } as any)
        .mockResolvedValueOnce({ id: 'log-credit' } as any);

      jest.spyOn(fxService, 'getRates').mockResolvedValue({
        version: 'v1',
        rates: { NGN: 1, USD: 0.0006 },
      } as any);

      jest.spyOn(walletRepo, 'findOne').mockResolvedValue({ id: mockWalletId } as any);

      const mockQueryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn()
          .mockResolvedValueOnce({ id: 'bal-ngn', currency: 'NGN', amount: 500000 })
          .mockResolvedValueOnce({ id: 'bal-usd', currency: 'USD', amount: 0 }),
      } as unknown as SelectQueryBuilder<Balance>;

      jest.spyOn(manager, 'createQueryBuilder').mockReturnValue(mockQueryBuilder);

      const result = await service.convertFunds(mockUserId, 'NGN', 'USD', 200000, 'idem-key');

      expect(result.status).toBe(TransactionStatus.SUCCESS);
      expect(transactionsService.recordTransaction).toHaveBeenCalledTimes(2);
      expect(transactionsService.updateTransaction).toHaveBeenCalledWith('log-debit', expect.anything(), expect.anything());
      expect(transactionsService.updateTransaction).toHaveBeenCalledWith('log-credit', expect.anything(), expect.anything());
    });
  });
});
