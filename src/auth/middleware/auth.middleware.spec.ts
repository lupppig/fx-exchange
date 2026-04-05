import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthMiddleware } from './auth.middleware.js';
import { Request, Response, NextFunction } from 'express';

describe('AuthMiddleware', () => {
  let middleware: AuthMiddleware;
  let jwtService: JwtService;

  const mockNext: NextFunction = jest.fn();
  const mockResponse = {} as Response;

  function makeRequest(authHeader?: string): Request {
    const req = {} as Request;
    if (authHeader) {
      req.headers = { authorization: authHeader };
    } else {
      req.headers = {};
    }
    return req;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthMiddleware,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-secret'),
          },
        },
      ],
    }).compile();

    middleware = module.get<AuthMiddleware>(AuthMiddleware);
    jwtService = module.get<JwtService>(JwtService);
  });

  it('should throw if no authorization header', async () => {
    const request = makeRequest();

    await expect(
      middleware.use(request, mockResponse, mockNext),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should throw if header does not start with Bearer', async () => {
    const request = makeRequest('Basic abc');

    await expect(
      middleware.use(request, mockResponse, mockNext),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should verify token and attach user to request', async () => {
    const payload = { sub: 'user-1', email: 'test@test.com' };
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue(payload);

    const request = makeRequest('Bearer valid-token');

    await middleware.use(request, mockResponse, mockNext);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('valid-token', {
      secret: 'test-secret',
    });
    expect((request as unknown as Record<string, unknown>).user).toEqual(
      payload,
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it('should throw if token verification fails', async () => {
    jest
      .spyOn(jwtService, 'verifyAsync')
      .mockRejectedValue(new Error('Invalid token'));

    const request = makeRequest('Bearer invalid-token');

    await expect(
      middleware.use(request, mockResponse, mockNext),
    ).rejects.toThrow(UnauthorizedException);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
