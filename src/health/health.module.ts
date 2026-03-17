import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RedisModule } from '@nestjs-modules/ioredis';
import { HealthController } from './health.controller.js';

@Module({
  imports: [TerminusModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}
