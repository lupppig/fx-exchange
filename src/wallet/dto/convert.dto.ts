import { IsNotEmpty, IsString, IsInt, Min, IsUppercase, Length } from 'class-validator';
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
    example: 100000,
    description: 'Amount of fromCurrency in smallest unit (e.g., kobo for NGN, cents for USD)',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  amount!: number;
}
