import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryRunner, Repository } from 'typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { TransactionLog } from './entities/transaction-log.entity';
import { TransactionType } from './enums/transaction-type.enum';
import { TransactionPurpose } from './enums/transaction-purpose.enum';
import { TransactionStatus } from './enums/transaction-status.enum';
import { OutboxService } from '../common/outbox/outbox.service';

export interface LedgerEntryInput {
  walletId: string;
  userId: string;
  type: TransactionType;
  currency: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface RecordJournalOptions {
  walletId: string;
  userId: string;
  purpose: TransactionPurpose;
  idempotencyKey: string;
  status?: TransactionStatus;
  exchangeRate?: number;
  entries: LedgerEntryInput[];
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(JournalEntry)
    private readonly journalRepo: Repository<JournalEntry>,
    private readonly outboxService: OutboxService,
  ) {}

  async recordJournalEntry(
    options: RecordJournalOptions,
    queryRunner: QueryRunner,
  ): Promise<JournalEntry> {
    const journal = queryRunner.manager.create(JournalEntry, {
      walletId: options.walletId,
      userId: options.userId,
      purpose: options.purpose,
      status: options.status ?? TransactionStatus.PENDING,
      idempotencyKey: options.idempotencyKey,
      exchangeRate: options.exchangeRate ?? null,
    });

    const savedJournal = await queryRunner.manager.save(journal);

    const entries = options.entries.map((entry) =>
      queryRunner.manager.create(TransactionLog, {
        journalEntry: savedJournal,
        walletId: entry.walletId,
        userId: entry.userId,
        type: entry.type,
        currency: entry.currency,
        amount: entry.amount,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
      }),
    );

    await queryRunner.manager.save(entries);

    await this.outboxService.addToOutbox(
      'journal.created',
      {
        journalId: savedJournal.id,
        walletId: options.walletId,
        userId: options.userId,
        purpose: options.purpose,
        status: options.status ?? TransactionStatus.PENDING,
        idempotencyKey: options.idempotencyKey,
        exchangeRate: options.exchangeRate ?? null,
        entries: options.entries,
      },
      queryRunner,
    );

    const saved = await queryRunner.manager.findOne(JournalEntry, {
      where: { id: savedJournal.id },
      relations: ['entries'],
    });

    if (!saved) {
      throw new Error('Failed to retrieve saved journal entry');
    }

    return saved;
  }

  async updateJournalStatus(
    journalId: string,
    status: TransactionStatus,
    queryRunner: QueryRunner,
    entryUpdates?: {
      entryId: string;
      balanceBefore: number;
      balanceAfter: number;
    }[],
  ): Promise<void> {
    await queryRunner.manager.update(JournalEntry, journalId, { status });

    if (entryUpdates) {
      for (const update of entryUpdates) {
        await queryRunner.manager.update(TransactionLog, update.entryId, {
          balanceBefore: update.balanceBefore,
          balanceAfter: update.balanceAfter,
        });
      }
    }
  }

  async findByIdempotencyKey(
    userId: string,
    key: string,
  ): Promise<JournalEntry | null> {
    return this.journalRepo.findOne({
      where: { userId, idempotencyKey: key },
      relations: ['entries'],
    });
  }

  /**
   * Fetches transaction history for a user with cursor-based pagination and filtering.
   *
   * Pagination is a strict keyset over (createdAt DESC, id DESC). The id
   * tiebreak is what makes the cursor robust: `createdAt` is a Postgres
   * timestamp(6) (microseconds) but a JS Date / ISO string only carries
   * milliseconds, so two journals can compare equal on createdAt. Without the
   * id tiebreak a boundary row gets silently skipped between pages.
   *
   * The `currency`/`type` filters select on the leg table via EXISTS rather
   * than a JOIN, so the journal's COMPLETE set of legs still hydrates (entries
   * are eager) -- a leg-level JOIN filter would truncate the entries array and
   * break double-entry consumers downstream.
   */
  async getTransactions(
    userId: string,
    query: {
      cursor?: string;
      limit?: number;
      currency?: string;
      type?: TransactionType;
      purpose?: TransactionPurpose;
    },
  ) {
    const { cursor, limit = 20, currency, type, purpose } = query;

    // Validate/decode the cursor up front so a malformed cursor fails fast
    // (BadRequestException) before we touch the database.
    const decodedCursor = cursor ? this.decodeCursor(cursor) : null;

    // Step 1: keyset page of journal IDs.
    //
    // We project `createdAt` through to_char at microsecond precision and use
    // THAT string (not the JS Date) for both the WHERE comparison and the
    // emitted cursor. node-postgres hydrates `timestamp` into a JS Date, which
    // only carries milliseconds -- so a Date-derived cursor silently truncates
    // the column's microseconds and the `createdAt = :cAt` tiebreak branch
    // could never match. Comparing text-to-timestamp keeps full precision.
    const idQb = this.journalRepo
      .createQueryBuilder('journal')
      .select('journal.id', 'id')
      .addSelect(
        `to_char(journal."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
        'cat',
      )
      .where('journal.userId = :userId', { userId })
      .orderBy('journal.createdAt', 'DESC')
      .addOrderBy('journal.id', 'DESC')
      .limit(limit + 1);

    if (decodedCursor) {
      idQb.andWhere(
        '(journal."createdAt" < :cAt::timestamp OR (journal."createdAt" = :cAt::timestamp AND journal.id < :cId))',
        { cAt: decodedCursor.createdAt, cId: decodedCursor.id },
      );
    }

    if (currency || type) {
      idQb.andWhere(
        `EXISTS (
          SELECT 1 FROM transaction_logs tl
          WHERE tl."journalEntryId" = journal.id
          ${currency ? 'AND tl.currency = :currency' : ''}
          ${type ? 'AND tl.type = :type' : ''}
        )`,
        {
          ...(currency ? { currency: currency.toUpperCase() } : {}),
          ...(type ? { type } : {}),
        },
      );
    }

    if (purpose) {
      idQb.andWhere('journal.purpose = :purpose', { purpose });
    }

    const rows: Array<{ id: string; cat: string }> = await idQb.getRawMany();

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? this.encodeCursor(lastRow.cat, lastRow.id)
        : null;

    // Step 2: hydrate the full journals (with their COMPLETE eager leg set --
    // findBy honors `eager: true`, unlike the query builder). Re-impose the
    // page order, since `In(...)` does not guarantee it.
    const ids = pageRows.map((r) => r.id);
    const items = ids.length
      ? await this.journalRepo
          .find({ where: { id: In(ids) } })
          .then((found) => {
            const byId = new Map(found.map((j) => [j.id, j]));
            return ids.map((id) => byId.get(id)!).filter(Boolean);
          })
      : [];

    return {
      items,
      nextCursor,
      hasNextPage,
    };
  }

  /** Opaque, precision-safe keyset cursor: base64url("<microsecond-ts>|<id>"). */
  private encodeCursor(createdAt: string, id: string): string {
    return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('Invalid cursor');
    }

    const sep = decoded.indexOf('|');
    if (sep === -1) {
      throw new BadRequestException('Invalid cursor');
    }

    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
      throw new BadRequestException('Invalid cursor');
    }

    return { createdAt, id };
  }
}
