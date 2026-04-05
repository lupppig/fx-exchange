import { TransformInterceptor } from './transform.interceptor.js';
import { of, lastValueFrom } from 'rxjs';

describe('TransformInterceptor', () => {
  let interceptor: TransformInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new TransformInterceptor();
  });

  it('should wrap response in standard format', async () => {
    const mockData = { message: 'hello' };
    const mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(mockData)),
    };

    const result = await lastValueFrom(
      interceptor.intercept(null as never, mockCallHandler),
    );

    expect(result).toEqual({
      success: true,
      timestamp: expect.any(String),
      data: mockData,
    });
  });

  it('should set timestamp to ISO string', async () => {
    const mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(null)),
    };

    const result = await lastValueFrom(
      interceptor.intercept(null as never, mockCallHandler),
    );

    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});
