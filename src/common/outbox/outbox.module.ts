import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEntry } from './entities/outbox-entry.entity.js';
import { OutboxService } from './outbox.service.js';
import { OutboxProcessor } from './outbox.processor.js';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEntry])],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService],
})
export class OutboxModule {}
