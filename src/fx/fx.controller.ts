import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { FxService, VersionedRates } from './fx.service';
import { QuoteService, Quote } from './quote.service';
import { CreateQuoteDto } from './dto/create-quote.dto';

interface AuthedRequest extends Request {
  user?: { id: string; email?: string };
}

@ApiTags('FX Rates')
@ApiBearerAuth()
@Controller('fx')
export class FxController {
  constructor(
    private readonly fxService: FxService,
    private readonly quoteService: QuoteService,
  ) {}

  @Get('rates')
  @ApiOperation({
    summary: 'Get current FX rates',
    description: 'Returns supported FX pairs with current rates, versioned for conversion consistency.',
  })
  @ApiResponse({
    status: 200,
    description: 'FX rates retrieved successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        timestamp: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            version: { type: 'string', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
            base: { type: 'string', example: 'USD' },
            timestamp: { type: 'string', example: '2026-03-17T12:00:00.000Z' },
            rates: {
              type: 'object',
              example: { USD: 1, EUR: 0.92, GBP: 0.79, NGN: 1550.5 },
            },
          },
        },
      },
    },
  })
  async getRates(): Promise<VersionedRates> {
    return this.fxService.getRates();
  }

  @Post('quotes')
  @ApiOperation({
    summary: 'Request a binding FX quote',
    description:
      'Returns a quote id, bid/ask, effective rate, and expiry. Pass the quote id to /wallet/trade to execute at the locked rate within the TTL.',
  })
  async createQuote(
    @Req() req: AuthedRequest,
    @Body() dto: CreateQuoteDto,
  ): Promise<Quote> {
    const userId = req.user!.id;
    return this.quoteService.createQuote({
      userId,
      fromCurrency: dto.fromCurrency,
      toCurrency: dto.toCurrency,
      amountInSubunits: BigInt(dto.amountInSubunits),
    });
  }
}
