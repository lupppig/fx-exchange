import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { OutboxEntry } from './entities/outbox-entry.entity';
import { OutboxService } from './outbox.service';
import { OutboxProcessor } from './outbox.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxEntry]),
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        exchanges: [
          {
            name: 'fx_exchange_events',
            type: 'topic',
            options: { durable: true },
          },
        ],
        uri: config.get<string>('RABBITMQ_URL', 'amqp://localhost'),
        connectionInitOptions: { wait: false },
        enableControllerDiscovery: false,
      }),
    }),
  ],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService],
})
export class OutboxModule {}
