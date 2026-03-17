import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { TransactionType } from '../enums/transaction-type.enum.js';
import { TransactionPurpose } from '../enums/transaction-purpose.enum.js';
import { TransactionStatus } from '../enums/transaction-status.enum.js';

@Entity('transaction_logs')
export class TransactionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  @Index()
  walletId!: string;

  @Column()
  @Index()
  userId!: string;

  @Column({ type: 'enum', enum: TransactionType })
  type!: TransactionType;

  @Column({ type: 'enum', enum: TransactionPurpose })
  purpose!: TransactionPurpose;

  @Column({ length: 3 })
  currency!: string;

  @Column({ type: 'bigint' })
  amount!: number;

  @Column({ type: 'bigint' })
  balanceBefore!: number;

  @Column({ type: 'bigint' })
  balanceAfter!: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  exchangeRate!: number | null;

  @Column({ unique: true })
  idempotencyKey!: string;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
