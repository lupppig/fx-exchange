import { IsNotEmpty, IsString, IsInt, Min, Max, IsUppercase, Length } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsSupportedCurrency } from '../../common/constants/supported-currencies.js';

export class FundWalletDto {
  @ApiProperty({
    example: 'NGN',
    description: 'ISO 4217 currency code',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  @IsSupportedCurrency()
  currency!: string;

  @ApiProperty({
    example: 100000,
    description: 'Amount in smallest currency unit (e.g., kobo for NGN, cents for USD)',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000_000, { message: 'Amount exceeds the maximum allowed value' })
  amount!: number;
}
