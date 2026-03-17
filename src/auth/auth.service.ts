import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Redis } from 'ioredis';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { MailService } from '../common/mail/mail.service.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly mailService: MailService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto) {
    // 1. Validate email uniqueness
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      this.logger.warn(`Registration attempt for existing email: ${dto.email}`);
      throw new BadRequestException('Email already exists');
    }

    // 2. Hash password
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // 3. Save user
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      isVerified: false,
    });

    // 4. Generate OTP
    const otp = crypto.randomInt(100000, 999999).toString();

    // 5. Hash OTP and store in Redis
    const hashedOtp = await bcrypt.hash(otp, 10);
    const otpKey = `otp:${user.id}`;
    const attemptsKey = `otp:attempts:${user.id}`;

    await this.redis.set(otpKey, hashedOtp, 'EX', 600); // 10 minutes
    await this.redis.set(attemptsKey, 0, 'EX', 900); // 15 minutes (grace period for attempts)

    // 6. Send OTP asynchronously (fire-and-forget)
    this.mailService.sendOtp(user.email, otp).catch((err) => {
      this.logger.error(`Failed to queue OTP email for ${user.email}`, err.stack);
    });

    return { message: 'Verification email sent' };
  }
}
