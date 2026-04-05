import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, QueryRunner } from 'typeorm';
import { TransactionsService } from './transactions.service.js';
import { TransactionLog } from './entities/transaction-log.entity.js';
import { JournalEntry } from './entities/journal-entry.entity.js';
import { TransactionType } from './enums/transaction-type.enum.js';
import { TransactionPurpose } from './enums/transaction-purpose.enum.js';
import { TransactionStatus } from './enums/transaction-status.enum.js';
import { OutboxService } from '../common/outbox/outbox.service.js';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let journalRepo: Repository<JournalEntry>;
  let outboxService: OutboxService;
  let mockQueryRunner: QueryRunner;

  beforeEach(async () => {
    mockQueryRunner = {
      manager: {
        create: jest.fn().mockImplementation((_entity, data) => ({ ...data })),
        save: jest.fn().mockImplementation(async (entity) => {
          if (Array.isArray(entity)) {
            return entity.map((e, i) => ({ ...e, id: `entry-${i}` }));
          }
          return { ...entity, id: 'journal-123' };
        }),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockImplementation(async (_entity, options) => ({
          id: 'journal-123',
          walletId: options.where?.id ? 'w1' : undefined,
          exchangeRate: 0.0006,
          entries: [
            {
              id: 'entry-0',
              journalEntryId: 'journal-123',
              walletId: 'w1',
              userId: 'u1',
              type: TransactionType.CREDIT,
              currency: 'USD',
              amount: 1000,
              balanceBefore: 0,
              balanceAfter: 1000,
            },
          ],
        })),
      },
    } as unknown as QueryRunner;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(JournalEntry),
          useValue: {
            findOne: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: OutboxService,
          useValue: {
            addToOutbox: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    journalRepo = module.get<Repository<JournalEntry>>(
      getRepositoryToken(JournalEntry),
    );
    outboxService = module.get<OutboxService>(OutboxService);
  });

  describe('recordJournalEntry', () => {
    it('should persist journal, write to outbox, and return saved journal', async () => {
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

      const result = await service.recordJournalEntry(options, mockQueryRunner);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        JournalEntry,
        expect.objectContaining({
          walletId: 'w1',
          userId: 'u1',
          purpose: TransactionPurpose.FUNDING,
          status: TransactionStatus.PENDING,
        }),
      );
      expect(outboxService.addToOutbox).toHaveBeenCalledWith(
        'journal.created',
        expect.objectContaining({
          journalId: 'journal-123',
          walletId: 'w1',
          userId: 'u1',
          purpose: TransactionPurpose.FUNDING,
        }),
        mockQueryRunner,
      );
      expect(result.id).toBe('journal-123');
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

      const result = await service.recordJournalEntry(options, mockQueryRunner);

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(outboxService.addToOutbox).toHaveBeenCalled();
      expect(result.entries).toHaveLength(1);
      expect(result.exchangeRate).toBe(0.0006);
    });
  });

  describe('updateJournalStatus', () => {
    it('should update journal status via QueryRunner', async () => {
      await service.updateJournalStatus(
        'journal-123',
        TransactionStatus.SUCCESS,
        mockQueryRunner,
      );

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        JournalEntry,
        'journal-123',
        { status: TransactionStatus.SUCCESS },
      );
    });

    it('should update entry balances when entryUpdates provided', async () => {
      const entryUpdates = [
        { entryId: 'entry-1', balanceBefore: 0, balanceAfter: 1000 },
      ];

      await service.updateJournalStatus(
        'journal-123',
        TransactionStatus.SUCCESS,
        mockQueryRunner,
        entryUpdates,
      );

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        JournalEntry,
        'journal-123',
        { status: TransactionStatus.SUCCESS },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        TransactionLog,
        'entry-1',
        { balanceBefore: 0, balanceAfter: 1000 },
      );
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

      jest
        .spyOn(journalRepo, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder as any);

      const result = await service.getTransactions('u1', { limit: 10 });

      expect(result.items).toBeDefined();
      expect(journalRepo.createQueryBuilder).toHaveBeenCalled();
    });
  });
});
