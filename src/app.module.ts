import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { WinstonModule, utilities as nestWinstonUtilities } from 'nest-winston';
import { RedisModule } from '@nestjs-modules/ioredis';
import { BullModule } from '@nestjs/bullmq';
import * as winston from 'winston';
import { envValidationSchema } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { UsersModule } from './users/users.module.js';
import { AuthModule } from './auth/auth.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { FxModule } from './fx/fx.module.js';
import { User } from './users/user.entity.js';

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
				synchronize: configService.get<boolean>('DB_SYNC'),
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
		WinstonModule.forRoot({
			transports: [
				new winston.transports.Console({
					format: winston.format.combine(
						winston.format.timestamp(),
						winston.format.ms(),
						nestWinstonUtilities.format.nestLike('FX-API', {
							colors: true,
							prettyPrint: true,
						}),
					),
				}),
			],
		}),
		HealthModule,
		UsersModule,
		AuthModule,
		WalletModule,
		FxModule,
	],
})
export class AppModule { }
