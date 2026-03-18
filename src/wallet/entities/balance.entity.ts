import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
  Check,
} from 'typeorm';
import { Expose, Exclude } from 'class-transformer';
import { Wallet } from './wallet.entity.js';
import { getSubunitFactor } from '../utils/currency.util.js';

@Entity('balances')
@Unique(['walletId', 'currency'])
@Check(`"amount" >= 0`)
@Check(`length("currency") = 3`)
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: false })
  walletId!: string;

  @ManyToOne(() => Wallet, (wallet) => wallet.balances)
  @JoinColumn({ name: 'walletId' })
  @Exclude()
  wallet!: Wallet;

  @Column({ length: 3, nullable: false })
  currency!: string;

  @Expose()
  get balanceDecimal(): number {
    const factor = getSubunitFactor(this.currency);
    return Number(this.amount) / factor;
  }

  @Expose()
  get balanceSubunits(): number {
    return Number(this.amount);
  }

  @Column({ type: 'bigint', default: 0 })
  @Exclude({ toPlainOnly: true })
  amount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
