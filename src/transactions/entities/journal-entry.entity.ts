import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { TransactionPurpose } from '../enums/transaction-purpose.enum.js';
import { TransactionStatus } from '../enums/transaction-status.enum.js';
import { TransactionLog } from './transaction-log.entity.js';

@Entity('journal_entries')
@Unique(['userId', 'idempotencyKey'])
export class JournalEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: false })
  @Index()
  walletId!: string;

  @Column({ nullable: false })
  @Index()
  userId!: string;

  @Column({ type: 'enum', enum: TransactionPurpose })
  @Index()
  purpose!: TransactionPurpose;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @Column({ nullable: false })
  idempotencyKey!: string;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  @Check(`"exchangeRate" IS NULL OR "exchangeRate" > 0`)
  exchangeRate!: number | null;

  @OneToMany(() => TransactionLog, (entry) => entry.journalEntry, { cascade: true, eager: true })
  entries!: TransactionLog[];

  @CreateDateColumn()
  @Index()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
