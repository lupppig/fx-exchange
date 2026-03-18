import { IsOptional, IsInt, Min, Max, IsISO8601 } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GetTransactionsDto {
  @ApiPropertyOptional({
    description: 'Cursor for pagination (ISO timestamp of last item from previous page). Leave empty for the first page.',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'Cursor must be a valid ISO 8601 timestamp' })
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of records to return (default 20, max 100)',
    example: 20,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
