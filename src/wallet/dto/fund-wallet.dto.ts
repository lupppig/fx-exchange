import { IsNotEmpty, IsString, IsInt, Min, MinLength, MaxLength } from 'class-validator';
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
    example: 100000,
    description: 'Amount in smallest currency unit (e.g., kobo for NGN, cents for USD)',
  })
  @IsInt()
  @Min(1)
  amount!: number;
}
