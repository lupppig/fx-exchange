import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { WalletService } from './wallet.service.js';
import { FundWalletDto } from './dto/fund-wallet.dto.js';
import { ConvertDto } from './dto/convert.dto.js';
import { TradeDto } from './dto/trade.dto.js';
import { GetTransactionsDto } from './dto/get-transactions.dto.js';
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
  @ApiResponse({ status: HttpStatus.OK, description: 'Wallet retrieved successfully.' })
  async getWallet(@CurrentUser('sub') userId: string) {
    return this.walletService.getWallet(userId);
  }

  @Post('fund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fund wallet',
    description: 'Credits the wallet with the specified currency and amount (in smallest unit, e.g., kobo). Requires an idempotency key header.',
  })
  @ApiHeader({
    name: 'x-idempotency-key',
    description: 'Unique key to prevent duplicate transactions',
    required: true,
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Wallet funded successfully.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid request or funding failure.' })
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

  @Post('convert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Convert currency',
    description: 'Converts funds from one currency to another using real-time FX rates. Amount in smallest unit.',
  })
  @ApiHeader({
    name: 'x-idempotency-key',
    description: 'Unique key to prevent duplicate conversions',
    required: true,
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Currency converted successfully.' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Insufficient balance, invalid currency pair, or amount too small.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'Insufficient USD balance' },
        error: { type: 'string', example: 'INSUFFICIENT_BALANCE' },
        details: {
          type: 'object',
          properties: {
            currency: { type: 'string', example: 'USD' },
            available: { type: 'number', example: 100000 },
            requested: { type: 'number', example: 200000 },
            shortfall: { type: 'number', example: 100000 },
          },
        },
      },
    },
  })
  async convert(
    @CurrentUser('sub') userId: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Body() dto: ConvertDto,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency key is required');
    }

    return this.walletService.convertFunds(
      userId,
      dto.fromCurrency,
      dto.toCurrency,
      dto.amount,
      idempotencyKey,
    );
  }

  @Post('trade')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trade currency',
    description: 'Trade Naira ↔ other currency using real-time FX rates. Amount in smallest unit.',
  })
  @ApiHeader({
    name: 'x-idempotency-key',
    description: 'Unique key to prevent duplicate trades',
    required: true,
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Trade executed successfully.' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Insufficient balance, invalid currency pair, or amount too small.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'Insufficient USD balance' },
        error: { type: 'string', example: 'INSUFFICIENT_BALANCE' },
        details: {
          type: 'object',
          properties: {
            currency: { type: 'string', example: 'USD' },
            available: { type: 'number', example: 100000 },
            requested: { type: 'number', example: 200000 },
            shortfall: { type: 'number', example: 100000 },
          },
        },
      },
    },
  })
  async trade(
    @CurrentUser('sub') userId: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Body() dto: TradeDto,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency key is required');
    }

    return this.walletService.tradeFunds(
      userId,
      dto.fromCurrency,
      dto.toCurrency,
      dto.amount,
      idempotencyKey,
    );
  }

  @Get('transactions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get transaction history',
    description: 'Returns paginated transaction history using cursor-based pagination. Ordered by timestamp descending.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'ISO timestamp cursor from previous page',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of records per page (default 20, max 100)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Transaction history retrieved successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            transactions: { type: 'array', items: { type: 'object' } },
            nextCursor: { type: 'string', nullable: true },
            count: { type: 'number', example: 20 },
          },
        },
      },
    },
  })
  async getTransactions(
    @CurrentUser('sub') userId: string,
    @Query() query: GetTransactionsDto,
  ) {
    return this.walletService.getTransactions(userId, query.cursor, query.limit);
  }
}
