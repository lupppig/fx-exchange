import { Expose, Type } from 'class-transformer';
import { Balance } from '../entities/balance.entity.js';

export class WalletResponseDto {
  @Expose()
  walletId!: string;

  @Expose()
  userId!: string;

  @Expose()
  @Type(() => Balance)
  balances!: Balance[];

  @Expose()
  createdAt!: Date;

  @Expose()
  updatedAt!: Date;
}
