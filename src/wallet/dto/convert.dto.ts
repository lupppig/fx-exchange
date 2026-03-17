import { IsNotEmpty, IsString, IsNumber, Min, IsUppercase, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ConvertDto {
  @ApiProperty({
    example: 'NGN',
    description: 'The currency to convert from',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  fromCurrency!: string;

  @ApiProperty({
    example: 'USD',
    description: 'The currency to convert to',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  toCurrency!: string;

  @ApiProperty({
    example: 1000,
    description: 'The amount of fromCurrency to convert',
    minimum: 0.01,
  })
  @IsNumber()
  @Min(0.01)
  amount!: number;
}
