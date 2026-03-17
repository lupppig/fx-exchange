import { ApiProperty } from '@nestjs/swagger';

export class HealthIndicatorResultDto {
  @ApiProperty({ example: 'up' })
  status!: string;
}

export type HealthCheckData = Record<string, HealthIndicatorResultDto>;

export class HealthCheckResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: '2026-03-17T08:54:09.000Z' })
  timestamp!: string;

  @ApiProperty({ 
    type: Object, 
    example: { 
      database: { status: 'up' },
      redis: { status: 'up' } 
    } 
  })
  data!: HealthCheckData;
}

export class SuccessResponseDto<T> {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: '2026-03-17T08:54:09.000Z' })
  timestamp!: string;

  @ApiProperty()
  data!: T;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success!: boolean;

  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: '2026-03-17T08:54:09.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 'Email already exists' })
  message!: string;
}
