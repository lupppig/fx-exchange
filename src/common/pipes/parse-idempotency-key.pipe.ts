import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';

const MAX_KEY_LENGTH = 255;

// Extracts and validates the x-idempotency-key header: present, non-empty,
// within length bounds.
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
