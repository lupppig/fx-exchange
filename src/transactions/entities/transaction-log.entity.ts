import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Check,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Expose, Exclude } from 'class-transformer';
import { TransactionType } from '../enums/transaction-type.enum.js';
import { JournalEntry } from './journal-entry.entity.js';
import { getSubunitFactor } from '../../wallet/utils/currency.util.js';

@Entity('transaction_logs')
@Check(`"amount" > 0`)
@Check(`"balanceBefore" >= 0`)
@Check(`"balanceAfter" >= 0`)
@Check(`length("currency") = 3`)
export class TransactionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: false })
  @Index()
  journalEntryId!: string;

  @ManyToOne(() => JournalEntry, (journal) => journal.entries)
  @JoinColumn({ name: 'journalEntryId' })
  @Exclude()
  journalEntry!: JournalEntry;

  @Column({ nullable: false })
  @Index()
  walletId!: string;

  @Column({ nullable: false })
  @Index()
  userId!: string;

  @Column({ type: 'enum', enum: TransactionType })
  @Index()
  type!: TransactionType;

  @Column({ length: 3, nullable: false })
  @Index()
  currency!: string;

  @Expose()
  get amountDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.amount) / factor;
  }

  @Expose()
  get amountSubunits(): number {
    return Number(this.amount);
  }

  @Column({ type: 'bigint' })
  @Exclude({ toPlainOnly: true })
  amount!: number;

  @Expose()
  get balanceBeforeDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.balanceBefore) / factor;
  }

  @Expose()
  get balanceBeforeSubunits(): number {
    return Number(this.balanceBefore);
  }

  @Column({ type: 'bigint' })
  @Exclude({ toPlainOnly: true })
  balanceBefore!: number;

  @Expose()
  get balanceAfterDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.balanceAfter) / factor;
  }

  @Expose()
  get balanceAfterSubunits(): number {
    return Number(this.balanceAfter);
  }

  @Column({ type: 'bigint' })
  @Exclude({ toPlainOnly: true })
  balanceAfter!: number;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;
}
