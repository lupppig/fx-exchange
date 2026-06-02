import { IsOptional, IsInt, Min, Max, IsISO8601, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsSupportedCurrency } from '../../common/constants/supported-currencies';
import { TransactionType } from '../../transactions/enums/transaction-type.enum';
import { TransactionPurpose } from '../../transactions/enums/transaction-purpose.enum';

export class GetTransactionsDto {
  @ApiPropertyOptional({
    description: 'cursor timestamp pagination',
  })
  @IsOptional()
  @IsISO8601()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Number of transactions to return (max 100)',
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ description: 'Filter by currency code' })
  @IsOptional()
  @IsSupportedCurrency()
  currency?: string;

  @ApiPropertyOptional({ description: 'Filter by transaction type', enum: TransactionType })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiPropertyOptional({ description: 'Filter by transaction purpose', enum: TransactionPurpose })
  @IsOptional()
  @IsEnum(TransactionPurpose)
  purpose?: TransactionPurpose;
}
