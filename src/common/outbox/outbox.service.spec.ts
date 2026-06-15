import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OutboxService } from './outbox.service';
import { OutboxEntry, OutboxStatus } from './entities/outbox-entry.entity';

describe('OutboxService', () => {
  let service: OutboxService;
  let queryMock: jest.Mock;
  let updateMock: jest.Mock;

  beforeEach(async () => {
    queryMock = jest.fn();
    updateMock = jest.fn().mockResolvedValue({ affected: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: getRepositoryToken(OutboxEntry),
          useValue: {
            query: queryMock,
            update: updateMock,
            find: jest.fn(),
          } as unknown as Repository<OutboxEntry>,
        },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  describe('claimPendingEntries', () => {
    it('issues an UPDATE ... FOR UPDATE SKIP LOCKED against PENDING rows', async () => {
      // pg driver returns [rows, affectedCount] on UPDATE ... RETURNING
      queryMock.mockResolvedValueOnce([
        [
          { id: 'a', status: OutboxStatus.PROCESSING },
          { id: 'b', status: OutboxStatus.PROCESSING },
        ],
        2,
      ]);

      const claimed = await service.claimPendingEntries(50);

      expect(claimed).toHaveLength(2);
      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
      expect(sql).toMatch(/RETURNING \*/);
      expect(params).toEqual([
        OutboxStatus.PROCESSING,
        OutboxStatus.PENDING,
        50,
      ]);
    });

    it('two concurrent claims never see the same row (split via the repo)', async () => {
      // Simulate the DB by handing out disjoint slices to each call;
      // FOR UPDATE SKIP LOCKED in Postgres provides this guarantee, and
      // the test asserts the service surfaces whatever the DB returns.
      queryMock
        .mockResolvedValueOnce([[{ id: 'a' }], 1])
        .mockResolvedValueOnce([[{ id: 'b' }], 1]);

      const [first, second] = await Promise.all([
        service.claimPendingEntries(10),
        service.claimPendingEntries(10),
      ]);

      const ids = new Set([...first, ...second].map((e) => e.id));
      expect(ids.size).toBe(2);
      expect(ids.has('a')).toBe(true);
      expect(ids.has('b')).toBe(true);
    });
  });

  describe('recoverStuckEntries', () => {
    it('flips stale PROCESSING rows back to PENDING and returns the count', async () => {
      // pg driver returns [rows, affectedCount] on UPDATE
      queryMock.mockResolvedValueOnce([[], 3]);

      const recovered = await service.recoverStuckEntries(60_000);

      expect(recovered).toBe(3);
      const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE outbox_entries/);
      expect(sql).toMatch(/status = \$2/);
      expect(sql).toMatch(/"claimedAt" < \(now\(\)/);
      expect(params).toEqual([
        OutboxStatus.PENDING,
        OutboxStatus.PROCESSING,
        '60000',
      ]);
    });

    it('returns 0 when nothing is stale', async () => {
      queryMock.mockResolvedValueOnce([[], 0]);
      await expect(service.recoverStuckEntries(60_000)).resolves.toBe(0);
    });
  });

  describe('markFailed', () => {
    it('moves a row to PENDING when retries remain', async () => {
      await service.markFailed('row-1', 'boom', 2, 5);

      expect(updateMock).toHaveBeenCalledWith('row-1', {
        status: OutboxStatus.PENDING,
        lastError: 'boom',
        retryCount: 2,
        claimedAt: null,
      });
    });

    it('moves a row to FAILED (dead letter) at maxRetries', async () => {
      await service.markFailed('row-1', 'boom', 5, 5);

      expect(updateMock).toHaveBeenCalledWith('row-1', {
        status: OutboxStatus.FAILED,
        lastError: 'boom',
        retryCount: 5,
        claimedAt: null,
      });
    });

    it('also moves to FAILED if retryCount somehow exceeds maxRetries', async () => {
      await service.markFailed('row-1', 'boom', 7, 5);

      expect(updateMock).toHaveBeenCalledWith(
        'row-1',
        expect.objectContaining({ status: OutboxStatus.FAILED }),
      );
    });
  });

  describe('markPublished', () => {
    it('flips the row to PUBLISHED and clears claimedAt', async () => {
      await service.markPublished('row-1');

      expect(updateMock).toHaveBeenCalledWith(
        'row-1',
        expect.objectContaining({
          status: OutboxStatus.PUBLISHED,
          claimedAt: null,
        }),
      );
      const [, patch] = updateMock.mock.calls[0] as [
        string,
        { publishedAt: Date },
      ];
      expect(patch.publishedAt).toBeInstanceOf(Date);
    });
  });
});
