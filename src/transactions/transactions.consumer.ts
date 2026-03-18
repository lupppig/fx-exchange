import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload, Ctx, RmqContext } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TransactionLog } from './entities/transaction-log.entity.js';

@Controller()
export class TransactionsConsumer {
  private readonly logger = new Logger(TransactionsConsumer.name);

  constructor(
    @InjectRepository(TransactionLog)
    private readonly repo: Repository<TransactionLog>,
  ) {}

  @MessagePattern('record_transaction')
  async handleRecord(@Payload() data: any, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.log(`Buffering write for transaction ${data.id}`);
      await this.repo.save(data);
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Failed to persist transaction ${data.id}:`, error);
      channel.nack(originalMsg, false, true); // requeue
    }
  }

  @MessagePattern('update_transaction')
  async handleUpdate(@Payload() data: { id: string; update: any }, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.log(`Updating buffered transaction ${data.id}`);
      await this.repo.update(data.id, data.update);
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(`Failed to update transaction ${data.id}:`, error);
      channel.nack(originalMsg, false, true);
    }
  }
}
