import { IsNotEmpty, IsString, IsInt, Min, IsUppercase, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TradeDto {
  @ApiProperty({
    example: 'USD',
    description: 'The currency to sell',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  fromCurrency!: string;

  @ApiProperty({
    example: 'NGN',
    description: 'The currency to buy',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  toCurrency!: string;

  @ApiProperty({
    example: 5000,
    description: 'Amount of fromCurrency in smallest unit (e.g., cents for USD, kobo for NGN)',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  amount!: number;
}
