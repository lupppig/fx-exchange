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

@ValidatorConstraint({ name: 'currenciesNotEqual', async: false })
class CurrenciesNotEqual implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as ConvertDto;
    return obj.fromCurrency !== obj.toCurrency;
  }

  defaultMessage(): string {
    return 'fromCurrency and toCurrency must be different';
  }
}

export class ConvertDto {
  @ApiProperty({
    example: 'NGN',
    description: 'The currency to convert from',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  @IsSupportedCurrency()
  fromCurrency!: string;

  @ApiProperty({
    example: 'USD',
    description: 'The currency to convert to',
  })
  @IsString()
  @IsNotEmpty()
  @IsUppercase()
  @Length(3, 3)
  @IsSupportedCurrency()
  @Validate(CurrenciesNotEqual)
  toCurrency!: string;

  @ApiProperty({
    example: 100000,
    description: 'Amount of fromCurrency in smallest unit (e.g., kobo for NGN, cents for USD)',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000_000, { message: 'Amount exceeds the maximum allowed value' })
  amount!: number;
}
