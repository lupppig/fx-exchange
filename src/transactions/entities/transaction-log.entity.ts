import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from 'typeorm';
import { Expose } from 'class-transformer';
import { TransactionType } from '../enums/transaction-type.enum.js';
import { TransactionPurpose } from '../enums/transaction-purpose.enum.js';
import { TransactionStatus } from '../enums/transaction-status.enum.js';
import { getSubunitFactor } from '../../wallet/utils/currency.util.js';

@Entity('transaction_logs')
@Check(`"amount" > 0`)
@Check(`"balanceBefore" >= 0`)
@Check(`"balanceAfter" >= 0`)
@Check(`length("currency") = 3`)
@Check(`"exchangeRate" IS NULL OR "exchangeRate" > 0`)
export class TransactionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: false })
  @Index()
  walletId!: string;

  @Column({ nullable: false })
  @Index()
  userId!: string;

  @Column({ type: 'enum', enum: TransactionType })
  @Index()
  type!: TransactionType;

  @Column({ type: 'enum', enum: TransactionPurpose })
  @Index()
  purpose!: TransactionPurpose;

  @Column({ length: 3, nullable: false })
  @Index()
  currency!: string;

  @Column({ type: 'bigint' })
  @Expose({ name: 'amountSubunits' })
  amount!: number;

  @Expose()
  get amountDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.amount) / factor;
  }

  @Column({ type: 'bigint' })
  @Expose({ name: 'balanceBeforeSubunits' })
  balanceBefore!: number;

  @Expose()
  get balanceBeforeDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.balanceBefore) / factor;
  }

  @Column({ type: 'bigint' })
  @Expose({ name: 'balanceAfterSubunits' })
  balanceAfter!: number;

  @Expose()
  get balanceAfterDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.balanceAfter) / factor;
  }

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  exchangeRate!: number | null;

  @Column({ unique: true, nullable: false })
  idempotencyKey!: string;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;

  @UpdateDateColumn()
  @Index()
  updatedAt!: Date;
}
