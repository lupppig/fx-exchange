import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { SigninDto } from './dto/signin.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Register a new user',
    description: 'Creates a new user account and triggers an OTP verification email.',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Registration initiated successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string', example: '2026-03-17T11:00:00Z' },
        data: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Verification email sent' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Bad request or validation error.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        timestamp: { type: 'string', example: '2026-03-17T11:00:00Z' },
        message: { type: 'string', example: 'Email already exists' },
      },
    },
  })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify OTP',
    description: 'Verifies the 6-digit OTP sent to the user email.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Email verified successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string', example: '2026-03-17T11:00:00Z' },
        data: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Email verified successfully' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid OTP or validation error.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        timestamp: { type: 'string', example: '2026-03-17T11:00:00Z' },
        message: { type: 'string', example: 'Invalid OTP' },
      },
    },
  })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Post('signin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'User Sign-in',
    description: 'Authenticates a user and returns a JWT access token.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User authenticated successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string', example: '2026-03-17T11:00:00Z' },
        data: {
          type: 'object',
          properties: {
            access_token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid credentials or validation error.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        timestamp: { type: 'string', example: '2026-03-17T11:00:00Z' },
        message: { type: 'string', example: 'Invalid credentials' },
      },
    },
  })
  async signin(@Body() dto: SigninDto) {
    return this.authService.signin(dto);
  }
}
