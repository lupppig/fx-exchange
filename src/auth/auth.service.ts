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

    this.mailService.sendOtp(user.email, otp).catch((err) => {
      this.logger.error(`Failed to queue OTP email for ${user.email}`, err.stack);
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
      throw new BadRequestException('Invalid OTP');
    }

    const isValid = await bcrypt.compare(dto.otp, hashedOtp);
    if (!isValid) {
      await this.redis.incr(attemptsKey);
      throw new BadRequestException('Invalid OTP');
    }

    await this.usersService.update(user.id, { isVerified: true });

    await this.redis.del(otpKey);
    await this.redis.del(attemptsKey);

    return { message: 'Email verified successfully' };
  }

  async signin(dto: SigninDto) {
    const user = await this.usersService.findByEmailWithPassword(dto.email);
    if (!user || !user.passwordHash) {
      throw new BadRequestException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new BadRequestException('Invalid credentials');
    }

    if (!user.isVerified) {
      throw new BadRequestException('Please verify your email first');
    }

    const payload = { sub: user.id, email: user.email };
    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }
}
