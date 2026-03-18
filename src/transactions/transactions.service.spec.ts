import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TransactionsService } from './transactions.service.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let repo: Repository<TransactionLog>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(TransactionLog),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            findOne: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    repo = module.get<Repository<TransactionLog>>(getRepositoryToken(TransactionLog));
  });

  describe('recordTransaction', () => {
    it('should create and save a transaction log', async () => {
      const options = {
        walletId: 'w1',
        userId: 'u1',
        type: TransactionType.CREDIT,
        purpose: TransactionPurpose.FUNDING,
        currency: 'NGN',
        amount: 1000,
        balanceBefore: 0,
        balanceAfter: 1000,
        idempotencyKey: 'key',
      };

      jest.spyOn(repo, 'create').mockReturnValue(options as any);
      jest.spyOn(repo, 'save').mockResolvedValue(options as any);

      const result = await service.recordTransaction(options);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining(options));
      expect(repo.save).toHaveBeenCalled();
      expect(result).toEqual(options);
    });
  });

  describe('getTransactions', () => {
    it('should fetch paginated transactions', async () => {
      const mockTxns = [{ id: '1', createdAt: new Date() }];
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockTxns),
      };

      jest.spyOn(repo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      const result = await service.getTransactions('u1', { limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(false);
    });
  });
});
