import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { WalletService } from './wallet.service.js';
import { FundWalletDto } from './dto/fund-wallet.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get wallet balances',
    description: 'Returns the authenticated user wallet with all currency balances.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Wallet retrieved successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string', example: '2026-03-17T12:00:00Z' },
        data: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'uuid' },
            userId: { type: 'string', example: 'uuid' },
            balances: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  currency: { type: 'string', example: 'NGN' },
                  amount: { type: 'string', example: '1000.0000' },
                },
              },
            },
          },
        },
      },
    },
  })
  async getWallet(@CurrentUser('sub') userId: string) {
    return this.walletService.getWallet(userId);
  }

  @Post('fund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fund wallet',
    description: 'Credits the wallet with the specified currency and amount. Requires an idempotency key header.',
  })
  @ApiHeader({
    name: 'x-idempotency-key',
    description: 'Unique key to prevent duplicate transactions',
    required: true,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Wallet funded successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string', example: '2026-03-17T12:00:00Z' },
        data: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Wallet funded successfully' },
            transaction: {
              type: 'object',
              properties: {
                id: { type: 'string', example: 'uuid' },
                type: { type: 'string', example: 'CREDIT' },
                purpose: { type: 'string', example: 'FUNDING' },
                currency: { type: 'string', example: 'NGN' },
                amount: { type: 'string', example: '1000.0000' },
                balanceBefore: { type: 'string', example: '0.0000' },
                balanceAfter: { type: 'string', example: '1000.0000' },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request or funding failure.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        timestamp: { type: 'string', example: '2026-03-17T12:00:00Z' },
        message: { type: 'string', example: 'Idempotency key is required' },
      },
    },
  })
  async fundWallet(
    @CurrentUser('sub') userId: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Body() dto: FundWalletDto,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency key is required');
    }

    return this.walletService.fundWallet(userId, dto.currency, dto.amount, idempotencyKey);
  }
}
