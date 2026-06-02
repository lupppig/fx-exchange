import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule, utilities as nestWinstonUtilities } from 'nest-winston';
import { RedisModule } from '@nestjs-modules/ioredis';
import { BullModule } from '@nestjs/bullmq';
import * as winston from 'winston';
import { envValidationSchema } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { WalletModule } from './wallet/wallet.module';
import { FxModule } from './fx/fx.module';
import { TransactionsModule } from './transactions/transactions.module';
import { LockModule } from './common/lock/lock.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { User } from './users/user.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: true,
        migrations: [__dirname + '/migrations/*.{js,ts}'],
        entities: [User],
        ssl: configService.get<string>('DATABASE_URL')?.includes('neon.tech')
          ? { rejectUnauthorized: false }
          : false,
        extra: {
          max: configService.get<number>('DB_POOL_MAX'),
          min: configService.get<number>('DB_POOL_MIN'),
        },
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('RATE_LIMIT_TTL', 60),
          limit: config.get<number>('RATE_LIMIT_LIMIT', 10),
        },
      ],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get('REDIS_URL'),
        },
      }),
    }),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'single',
        url: configService.get('REDIS_URL'),
      }),
    }),
    WinstonModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProduction = config.get('NODE_ENV') === 'production';

        return {
          transports: [
            new winston.transports.Console({
              format: isProduction
                ? winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.errors({ stack: true }),
                    winston.format.json(),
                  )
                : winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.ms(),
                    nestWinstonUtilities.format.nestLike('FX-API', {
                      colors: true,
                      prettyPrint: true,
                    }),
                  ),
            }),
          ],
        };
      },
    }),
    OutboxModule,
    HealthModule,
    UsersModule,
    AuthModule,
    WalletModule,
    FxModule,
    TransactionsModule,
    LockModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
