import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
} from 'typeorm';
import { Wallet } from './wallet.entity.js';

@Entity('balances')
@Unique(['walletId', 'currency'])
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  walletId!: string;

  @ManyToOne(() => Wallet, (wallet) => wallet.balances)
  @JoinColumn({ name: 'walletId' })
  wallet!: Wallet;

  @Column({ length: 3 })
  currency!: string;

  @Column({ type: 'bigint', default: 0 })
  amount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
