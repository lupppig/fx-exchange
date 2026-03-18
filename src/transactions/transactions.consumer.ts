import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload, Ctx, RmqContext } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JournalEntry } from './entities/journal-entry.entity.js';
import { TransactionLog } from './entities/transaction-log.entity.js';

@Controller()
export class TransactionsConsumer {
  private readonly logger = new Logger(TransactionsConsumer.name);

  constructor(
    @InjectRepository(JournalEntry)
    private readonly journalRepo: Repository<JournalEntry>,
    @InjectRepository(TransactionLog)
    private readonly logRepo: Repository<TransactionLog>,
  ) {}

  @EventPattern('record_journal')
  async handleRecordJournal(@Payload() data: any, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.log(`Persisting journal entry ${data.id} with ${data.entries?.length ?? 0} ledger entries`);

      const { entries, ...journalData } = data;
      await this.journalRepo.save(journalData);

      if (entries && entries.length > 0) {
        await this.logRepo.save(entries);
      }

      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Failed to persist journal ${data.id}:`, error);
      channel.nack(originalMsg, false, true);
    }
  }

  @EventPattern('update_journal')
  async handleUpdateJournal(
    @Payload() data: { journalId: string; status: string; entryUpdates?: { entryId: string; balanceBefore: number; balanceAfter: number }[] },
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.log(`Updating journal ${data.journalId} status to ${data.status}`);

      await this.journalRepo.update(data.journalId, { status: data.status as any });

      if (data.entryUpdates) {
        for (const update of data.entryUpdates) {
          await this.logRepo.update(update.entryId, {
            balanceBefore: update.balanceBefore,
            balanceAfter: update.balanceAfter,
          });
        }
      }

      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Failed to update journal ${data.journalId}:`, error);
      channel.nack(originalMsg, false, true);
    }
  }
}
