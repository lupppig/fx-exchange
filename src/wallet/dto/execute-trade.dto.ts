import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class ExecuteTradeDto {
  @ApiProperty({
    description:
      'The id of a quote previously obtained from POST /fx/quotes. Must not be expired or already used.',
  })
  @IsUUID()
  quoteId!: string;

  @ApiProperty({
    description:
      'Client-generated key to make this trade safely retryable. Identical (userId, idempotencyKey) pairs return the original result.',
  })
  @IsString()
  idempotencyKey!: string;
}
