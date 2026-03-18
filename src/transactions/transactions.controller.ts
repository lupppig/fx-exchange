import {
  Controller,
  Get,
  Query,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { GetTransactionsDto } from '../wallet/dto/get-transactions.dto.js';

@ApiTags('Transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get transaction history',
    description: 'Fetch paginated history with support for filtering by currency, type, and purpose.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of transactions returned.' })
  async getTransactions(
    @CurrentUser('sub') userId: string,
    @Query() dto: GetTransactionsDto,
  ) {
    return this.transactionsService.getTransactions(userId, dto);
  }
}
