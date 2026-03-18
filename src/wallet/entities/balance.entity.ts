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
import { Wallet } from './wallet.entity.js';

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
  wallet!: Wallet;

  @Column({ length: 3, nullable: false })
  currency!: string;

  @Column({ type: 'bigint', default: 0 })
  amount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
