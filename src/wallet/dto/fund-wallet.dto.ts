import { IsNotEmpty, IsString, IsNumber, Min, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FundWalletDto {
  @ApiProperty({
    example: 'NGN',
    description: 'ISO 4217 currency code',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(3)
  currency!: string;

  @ApiProperty({
    example: 100.00,
    description: 'Amount to fund',
  })
  @IsNumber()
  @Min(0.01)
  amount!: number;
}
