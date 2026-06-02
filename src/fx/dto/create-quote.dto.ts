import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsInt, Min } from 'class-validator';
import { IsSupportedCurrency } from '../../common/constants/supported-currencies';

export class CreateQuoteDto {
  @ApiProperty({ example: 'NGN', description: 'Currency the user is selling' })
  @IsString()
  @IsSupportedCurrency()
  fromCurrency!: string;

  @ApiProperty({ example: 'USD', description: 'Currency the user is buying' })
  @IsString()
  @IsSupportedCurrency()
  toCurrency!: string;

  @ApiProperty({
    example: 1000000,
    description: 'Amount of fromCurrency in subunits (e.g. 100 NGN = 10000 kobo)',
  })
  @IsInt()
  @Min(1)
  amountInSubunits!: number;
}
