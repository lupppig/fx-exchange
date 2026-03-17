import { Controller, Get } from '@nestjs/common';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { ApiTags, ApiOperation, ApiOkResponse, ApiInternalServerErrorResponse } from '@nestjs/swagger';
import { HealthCheckResponseDto, ErrorResponseDto } from '../common/dto/api-response.dto.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    @InjectRedis() private redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ 
    summary: 'Check API, Database, and Redis health status',
    description: 'Returns the health status of the application, its connection to the PostgreSQL database, and the Redis store.'
  })
  @ApiOkResponse({
    description: 'The application is healthy and all infrastructure connections (DB, Redis) are accessible.',
    type: HealthCheckResponseDto,
  })
  @ApiInternalServerErrorResponse({
    description: 'The health check failed (e.g., database is down).',
    type: ErrorResponseDto,
  })
  async check() {
    const result = await this.health.check([
      () => this.db.pingCheck('database'),
      async () => {
        try {
          await this.redis.ping();
          return { redis: { status: 'up' } };
        } catch (err) {
          return { redis: { status: 'down', message: err instanceof Error ? err.message : 'Unknown error' } };
        }
      },
    ]);

    return result.details;
  }
}
