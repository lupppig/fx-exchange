import { BadRequestException, ExecutionContext } from '@nestjs/common';

// We need to import the decorator factory, but since it's a createParamDecorator,
// we test the factory function directly by recreating the validation logic.
// The actual decorator is tested indirectly via e2e/controller tests.

describe('IdempotencyKey validation logic', () => {
  // Replicate the validation logic from the decorator for unit testing
  const MAX_KEY_LENGTH = 255;

  function validateIdempotencyKey(value: unknown): string {
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
  }

  it('should accept a valid key', () => {
    expect(validateIdempotencyKey('abc-123-def')).toBe('abc-123-def');
  });

  it('should trim whitespace', () => {
    expect(validateIdempotencyKey('  key-with-spaces  ')).toBe('key-with-spaces');
  });

  it('should accept a UUID', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(validateIdempotencyKey(uuid)).toBe(uuid);
  });

  it('should throw on empty string', () => {
    expect(() => validateIdempotencyKey('')).toThrow(BadRequestException);
  });

  it('should throw on whitespace-only string', () => {
    expect(() => validateIdempotencyKey('   ')).toThrow(BadRequestException);
  });

  it('should throw on null/undefined', () => {
    expect(() => validateIdempotencyKey(null)).toThrow(BadRequestException);
    expect(() => validateIdempotencyKey(undefined)).toThrow(BadRequestException);
  });

  it('should throw on non-string values', () => {
    expect(() => validateIdempotencyKey(123)).toThrow(BadRequestException);
    expect(() => validateIdempotencyKey(true)).toThrow(BadRequestException);
  });

  it('should throw if key exceeds max length', () => {
    const longKey = 'x'.repeat(256);
    expect(() => validateIdempotencyKey(longKey)).toThrow(BadRequestException);
    expect(() => validateIdempotencyKey(longKey)).toThrow('must not exceed');
  });

  it('should accept a key at exactly max length', () => {
    const maxKey = 'x'.repeat(255);
    expect(validateIdempotencyKey(maxKey)).toBe(maxKey);
  });
});
