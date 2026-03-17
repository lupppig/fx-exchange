import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Register a new user',
    description:
      'Creates a new user account and triggers an OTP verification email. Returns a message indicating the email has been sent.',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'User registration initiated successfully. Verification email sent.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string', example: '2026-03-17T10:44:27Z' },
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
    description: 'Bad request (e.g., email already exists).',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        timestamp: { type: 'string', example: '2026-03-17T10:44:27Z' },
        message: { type: 'string', example: 'Email already exists' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Validation failed (e.g., weak password, invalid email).',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 422 },
        timestamp: { type: 'string', example: '2026-03-17T10:44:27Z' },
        errors: {
          type: 'object',
          properties: {
            password: {
              type: 'string',
              example:
                'Password is too weak. It must contain at least one uppercase letter, one lowercase letter, one number and one special character.',
            },
            email: { type: 'string', example: 'email must be an email' },
          },
        },
      },
    },
  })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }
}
