import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Canonical list of supported currencies.
 * Must stay in sync with SUBUNIT_FACTORS in currency.util.ts.
 */
export const SUPPORTED_CURRENCIES = [
  'NGN', 'USD', 'EUR', 'GBP', 'CAD', 'AUD',
  'CHF', 'JPY', 'CNY', 'ZAR', 'KES', 'GHS',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const SUPPORTED_SET = new Set<string>(SUPPORTED_CURRENCIES);

export function isSupportedCurrency(value: string): boolean {
  return SUPPORTED_SET.has(value?.toUpperCase?.());
}

@ValidatorConstraint({ name: 'isSupportedCurrency', async: false })
export class IsSupportedCurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isSupportedCurrency(value);
  }

  defaultMessage(): string {
    return `Currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`;
  }
}

/**
 * Custom class-validator decorator.
 * Validates that a string field is a supported currency code.
 */
export function IsSupportedCurrency(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsSupportedCurrencyConstraint,
    });
  };
}
