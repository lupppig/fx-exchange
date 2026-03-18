import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';

const MAX_KEY_LENGTH = 255;

/**
 * Custom parameter decorator that extracts and validates
 * the x-idempotency-key header from the incoming request.
 *
 * Ensures the key is present, non-empty, and within length bounds.
 *
 * Usage:
 *   @Post()
 *   async create(@IdempotencyKey() key: string) { ... }
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const value = request.headers['x-idempotency-key'];

    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(
        'x-idempotency-key header is required and must be a non-empty string',
      );
    }

    const trimmed = value.trim();

    if (trimmed.length > MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `x-idempotency-key must not exceed ${MAX_KEY_LENGTH} characters`,
      );
    }

    return trimmed;
  },
);
