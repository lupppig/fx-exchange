import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { TransactionsService } from './transactions.service.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { JournalEntry } from './entities/journal-entry.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let journalRepo: Repository<JournalEntry>;
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
          provide: getRepositoryToken(JournalEntry),
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
    journalRepo = module.get<Repository<JournalEntry>>(getRepositoryToken(JournalEntry));
    client = module.get<ClientProxy>('TRANSACTIONS_SERVICE');
  });

  describe('recordJournalEntry', () => {
    it('should emit record_journal message and return journal with entries', async () => {
      const options = {
        walletId: 'w1',
        userId: 'u1',
        purpose: TransactionPurpose.FUNDING,
        idempotencyKey: 'key',
        entries: [
          {
            walletId: 'w1',
            userId: 'u1',
            type: TransactionType.CREDIT,
            currency: 'USD',
            amount: 1000,
            balanceBefore: 0,
            balanceAfter: 1000,
          },
        ],
      };

      const result = await service.recordJournalEntry(options);

      expect(client.emit).toHaveBeenCalledWith('record_journal', expect.objectContaining({
        id: expect.any(String),
        walletId: 'w1',
        userId: 'u1',
        purpose: TransactionPurpose.FUNDING,
        status: TransactionStatus.PENDING,
        entries: expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String),
            journalEntryId: expect.any(String),
            type: TransactionType.CREDIT,
            currency: 'USD',
            amount: 1000,
          }),
        ]),
      }));
      expect(result.id).toBeDefined();
      expect(result.entries).toHaveLength(1);
    });

    it('should create journal with paired DEBIT + CREDIT entries for conversion', async () => {
      const options = {
        walletId: 'w1',
        userId: 'u1',
        purpose: TransactionPurpose.EXCHANGE,
        idempotencyKey: 'conv-key',
        exchangeRate: 0.0006,
        entries: [
          {
            walletId: 'w1',
            userId: 'u1',
            type: TransactionType.DEBIT,
            currency: 'NGN',
            amount: 200000,
            balanceBefore: 0,
            balanceAfter: 0,
          },
          {
            walletId: 'w1',
            userId: 'u1',
            type: TransactionType.CREDIT,
            currency: 'USD',
            amount: 120,
            balanceBefore: 0,
            balanceAfter: 0,
          },
        ],
      };

      const result = await service.recordJournalEntry(options);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].type).toBe(TransactionType.DEBIT);
      expect(result.entries[1].type).toBe(TransactionType.CREDIT);
      expect(result.exchangeRate).toBe(0.0006);
    });
  });

  describe('updateJournalStatus', () => {
    it('should emit update_journal message', async () => {
      await service.updateJournalStatus('journal-123', TransactionStatus.SUCCESS, [
        { entryId: 'entry-1', balanceBefore: 0, balanceAfter: 1000 },
      ]);

      expect(client.emit).toHaveBeenCalledWith('update_journal', {
        journalId: 'journal-123',
        status: TransactionStatus.SUCCESS,
        entryUpdates: [{ entryId: 'entry-1', balanceBefore: 0, balanceAfter: 1000 }],
      });
    });
  });

  describe('findByIdempotencyKey', () => {
    it('should query journal entries by userId and idempotencyKey', async () => {
      jest.spyOn(journalRepo, 'findOne').mockResolvedValue(null);

      await service.findByIdempotencyKey('u1', 'key');

      expect(journalRepo.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1', idempotencyKey: 'key' },
        relations: ['entries'],
      });
    });
  });

  describe('getTransactions', () => {
    it('should fetch journal entries using query builder', async () => {
      const mockJournals = [{ id: '1', createdAt: new Date(), entries: [] }];
      const mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockJournals),
      };

      jest.spyOn(journalRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      const result = await service.getTransactions('u1', { limit: 10 });

      expect(result.items).toBeDefined();
      expect(journalRepo.createQueryBuilder).toHaveBeenCalled();
    });
  });
});
