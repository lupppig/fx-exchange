import {
  IsNotEmpty,
  IsString,
  IsInt,
  Min,
  Max,
  IsUppercase,
  Length,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsSupportedCurrency } from '../../common/constants/supported-currencies.js';

@ValidatorConstraint({ name: 'tradeCurrenciesNotEqual', async: false })
class CurrenciesNotEqual implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as TradeDto;
    return obj.fromCurrency !== obj.toCurrency;
  }

  defaultMessage(): string {
    return 'fromCurrency and toCurrency must be different';
  }
}

export class TradeDto {
  @ApiProperty({
    example: 'USD',
    description: 'The currency to sell',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  @IsSupportedCurrency()
  fromCurrency!: string;

  @ApiProperty({
    example: 'NGN',
    description: 'The currency to buy',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  @IsSupportedCurrency()
  @Validate(CurrenciesNotEqual)
  toCurrency!: string;

  @ApiProperty({
    example: 5000,
    description: 'Amount of fromCurrency in smallest unit (e.g., cents for USD, kobo for NGN)',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000_000, { message: 'Amount exceeds the maximum allowed value' })
  amount!: number;
}
