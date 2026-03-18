import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { TransactionsService } from './transactions.service.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let repo: Repository<TransactionLog>;
  let client: ClientProxy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(TransactionLog),
          useValue: {
            findOne: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: 'TRANSACTIONS_SERVICE',
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    repo = module.get<Repository<TransactionLog>>(getRepositoryToken(TransactionLog));
    client = module.get<ClientProxy>('TRANSACTIONS_SERVICE');
  });

  describe('recordTransaction', () => {
    it('should emit record_transaction message and return log with UUID', async () => {
      const options = {
        walletId: 'w1',
        userId: 'u1',
        type: TransactionType.CREDIT,
        purpose: TransactionPurpose.FUNDING,
        currency: 'USD',
        amount: 1000,
        balanceBefore: 0,
        balanceAfter: 1000,
        idempotencyKey: 'key',
      };

      const result = await service.recordTransaction(options as any);

      expect(client.emit).toHaveBeenCalledWith('record_transaction', expect.objectContaining({
        ...options,
        id: expect.any(String),
        createdAt: expect.any(Date),
      }));
      expect(result.id).toBeDefined();
    });
  });

  describe('updateTransaction', () => {
    it('should emit update_transaction message', async () => {
      const id = 'txn-123';
      const update = { status: TransactionStatus.SUCCESS };

      await service.updateTransaction(id, update);

      expect(client.emit).toHaveBeenCalledWith('update_transaction', { id, update });
    });
  });

  describe('getTransactions', () => {
    it('should fetch transactions using query builder', async () => {
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

      expect(result.items).toBeDefined();
      expect(repo.createQueryBuilder).toHaveBeenCalled();
    });
  });
});
