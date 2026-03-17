import { IsNotEmpty, IsString, IsNumber, Min, IsUppercase, Length } from 'class-validator';
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
    example: 50,
    description: 'The amount of fromCurrency to trade',
    minimum: 0.01,
  })
  @IsNumber()
  @Min(0.01)
  amount!: number;
}
