import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { FundWalletDto } from './dto/fund-wallet.dto';
import { ConvertDto } from './dto/convert.dto';
import { ExecuteTradeDto } from './dto/execute-trade.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/pipes/parse-idempotency-key.pipe';

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get wallet balances',
    description:
      'Returns the authenticated user wallet with all currency balances.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Wallet retrieved successfully.',
  })
  async getWallet(@CurrentUser('sub') userId: string) {
    return this.walletService.getWallet(userId);
  }

  @Post('fund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fund wallet',
    description:
      'Credits the wallet with the specified currency and amount (in smallest unit, e.g., kobo). Requires an idempotency key header.',
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
        message: { type: 'string', example: 'Wallet funded successfully' },
        status: { type: 'string', example: 'SUCCESS' },
        transaction: { type: 'object' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request or funding failure.',
  })
  async fundWallet(
    @CurrentUser('sub') userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: FundWalletDto,
  ) {
    return this.walletService.fundWallet(
      userId,
      dto.currency,
      dto.amount,
      idempotencyKey,
    );
  }

  @Post('convert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Convert currency',
    description:
      'Converts funds from one currency to another using real-time FX rates. Amount in smallest unit.',
  })
  @ApiHeader({
    name: 'x-idempotency-key',
    description: 'Unique key to prevent duplicate conversions',
    required: true,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Currency converted successfully.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Conversion successful' },
        status: { type: 'string', example: 'SUCCESS' },
        rateVersion: { type: 'string' },
        exchangeRate: { type: 'number' },
        debit: { type: 'object' },
        credit: { type: 'object' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Insufficient balance, invalid currency pair, or amount too small.',
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
    @IdempotencyKey() idempotencyKey: string,
    @Body() dto: ConvertDto,
  ) {
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
    summary: 'Execute a previously-issued FX quote',
    description:
      'Trades at the rate locked in the quote. The quote must belong to the caller, not be expired, and not have been used.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Trade executed successfully.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Quote expired/unknown/already used, insufficient balance, or rejected.',
  })
  async trade(
    @CurrentUser('sub') userId: string,
    @Body() dto: ExecuteTradeDto,
  ) {
    return this.walletService.executeTrade(
      userId,
      dto.quoteId,
      dto.idempotencyKey,
    );
  }
}
