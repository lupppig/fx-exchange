import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { SigninDto } from './dto/signin.dto.js';
import { MailService } from '../common/mail/mail.service.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto) {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      isVerified: false,
    });

    const otp = crypto.randomInt(100000, 999999).toString();

    const hashedOtp = await bcrypt.hash(otp, 10);
    const otpKey = `otp:${user.id}`;
    const attemptsKey = `otp:attempts:${user.id}`;

    await this.redis.set(otpKey, hashedOtp, 'EX', 600);
    await this.redis.set(attemptsKey, 0, 'EX', 900);

    this.logger.log({
      message: 'User registered, OTP sent',
      userId: user.id,
      email: dto.email,
    });

    this.mailService.sendOtp(user.email, otp).catch((err) => {
      this.logger.error({
        message: 'Failed to send OTP email',
        userId: user.id,
        email: dto.email,
        error: err.message,
      });
    });

    return { message: 'Verification email sent' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user || user.isVerified) {
      throw new BadRequestException('Invalid OTP');
    }

    const otpKey = `otp:${user.id}`;
    const attemptsKey = `otp:attempts:${user.id}`;

    const hashedOtp = await this.redis.get(otpKey);
    const attempts = await this.redis.get(attemptsKey);

    if (!hashedOtp || (attempts && parseInt(attempts) >= 5)) {
      this.logger.warn({
        message: 'OTP verification failed - expired or max attempts',
        userId: user.id,
        email: dto.email,
      });
      throw new BadRequestException('Invalid OTP');
    }

    const isValid = await bcrypt.compare(dto.otp, hashedOtp);
    if (!isValid) {
      await this.redis.incr(attemptsKey);
      this.logger.warn({
        message: 'Invalid OTP attempt',
        userId: user.id,
        email: dto.email,
        attempts: attempts ? parseInt(attempts) + 1 : 1,
      });
      throw new BadRequestException('Invalid OTP');
    }

    await this.usersService.update(user.id, { isVerified: true });

    await this.redis.del(otpKey);
    await this.redis.del(attemptsKey);

    this.logger.log({
      message: 'User email verified',
      userId: user.id,
      email: dto.email,
    });

    return { message: 'Email verified successfully' };
  }

  async signin(dto: SigninDto) {
    const user = await this.usersService.findByEmailWithPassword(dto.email);
    if (!user || !user.passwordHash) {
      this.logger.warn({
        message: 'Signin failed - user not found',
        email: dto.email,
      });
      throw new BadRequestException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      this.logger.warn({
        message: 'Signin failed - invalid password',
        userId: user.id,
        email: dto.email,
      });
      throw new BadRequestException('Invalid credentials');
    }

    if (!user.isVerified) {
      this.logger.warn({
        message: 'Signin failed - email not verified',
        userId: user.id,
        email: dto.email,
      });
      throw new BadRequestException('Please verify your email first');
    }

    const payload = { sub: user.id, email: user.email };
    const token = await this.jwtService.signAsync(payload);

    this.logger.log({
      message: 'User signed in',
      userId: user.id,
      email: dto.email,
    });

    return { access_token: token };
  }
}
