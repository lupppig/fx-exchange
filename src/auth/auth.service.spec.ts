import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { MailService } from '../common/mail/mail.service';
import { AuthService } from './auth.service';
import { getRedisConnectionToken } from '@nestjs-modules/ioredis';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt');

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let mailService: jest.Mocked<MailService>;
  let jwtService: jest.Mocked<JwtService>;
  let redisClient: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            findByEmailWithPassword: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: {
            sendOtp: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn(),
          },
        },
        {
          provide: getRedisConnectionToken('default'),
          useValue: {
            set: jest.fn(),
            get: jest.fn(),
            incr: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get(UsersService);
    mailService = module.get(MailService);
    jwtService = module.get(JwtService);
    redisClient = module.get(getRedisConnectionToken('default'));

    (bcrypt.hash as jest.Mock).mockImplementation((val) => `hashed_${val}`);
    (bcrypt.compare as jest.Mock).mockImplementation((plain, hashed) => hashed === `hashed_${plain}`);
  });

  describe('register', () => {
    it('should throw if email exists', async () => {
      usersService.findByEmail.mockResolvedValue({ id: '1' } as any);
      await expect(service.register({ email: 'test@test.com', password: 'pwd' })).rejects.toThrow(BadRequestException);
    });

    it('should create user and queue OTP', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue({ id: '1', email: 'test@test.com' } as any);

      const result = await service.register({ email: 'test@test.com', password: 'pwd' });

      expect(usersService.create).toHaveBeenCalled();
      expect(redisClient.set).toHaveBeenCalledTimes(2); // OTP and attempts
      expect(mailService.sendOtp).toHaveBeenCalled();
      expect(result.message).toBe('Verification email sent');
    });
  });

  describe('verifyOtp', () => {
    it('should verify correct OTP', async () => {
      usersService.findByEmail.mockResolvedValue({ id: '1', isVerified: false } as any);
      redisClient.get.mockImplementation(async (key: string) => {
        if (key.includes('attempts')) return '0';
        return 'hashed_123456';
      });

      const result = await service.verifyOtp({ email: 'test@test.com', otp: '123456' });

      expect(usersService.update).toHaveBeenCalledWith('1', { isVerified: true });
      expect(redisClient.del).toHaveBeenCalledTimes(2);
      expect(result.message).toBe('Email verified successfully');
    });

    it('should throw and increment attempts on wrong OTP', async () => {
      usersService.findByEmail.mockResolvedValue({ id: '1', isVerified: false } as any);
      redisClient.get.mockImplementation(async (key: string) => {
        if (key.includes('attempts')) return '0';
        return 'hashed_123456';
      });

      await expect(service.verifyOtp({ email: 'test@test.com', otp: 'wrong' })).rejects.toThrow('Invalid OTP');
      expect(redisClient.incr).toHaveBeenCalled();
    });

    it('should throw if rate limited (5 attempts)', async () => {
      usersService.findByEmail.mockResolvedValue({ id: '1', isVerified: false } as any);
      redisClient.get.mockImplementation(async (key: string) => {
        if (key.includes('attempts')) return '5';
        return 'hashed_123456';
      });

      await expect(service.verifyOtp({ email: 'test@test.com', otp: '123456' })).rejects.toThrow('Invalid OTP');
    });
  });

  describe('signin', () => {
    it('should throw on wrong password', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue({ id: '1', passwordHash: 'hashed_pwd' } as any);
      await expect(service.signin({ email: 'test@test.com', password: 'wrong' })).rejects.toThrow('Invalid credentials');
    });

    it('should throw if unverified', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue({ id: '1', passwordHash: 'hashed_pwd', isVerified: false } as any);
      await expect(service.signin({ email: 'test@test.com', password: 'pwd' })).rejects.toThrow('Please verify your email first');
    });

    it('should return JWT on success', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue({ id: '1', email: 'test@test.com', passwordHash: 'hashed_pwd', isVerified: true } as any);
      jwtService.signAsync.mockResolvedValue('jwt_token');

      const result = await service.signin({ email: 'test@test.com', password: 'pwd' });

      expect(result.access_token).toBe('jwt_token');
    });
  });
});
