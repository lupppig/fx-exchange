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

  @Column({ type: 'enum', enum: TransactionType })
  type!: TransactionType;

  @Column({ type: 'enum', enum: TransactionPurpose })
  purpose!: TransactionPurpose;

  @Column({ length: 3 })
  currency!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  amount!: number;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  balanceBefore!: number;

  @Column({ type: 'decimal', precision: 18, scale: 4 })
  balanceAfter!: number;

  @Column({ unique: true })
  idempotencyKey!: string;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
