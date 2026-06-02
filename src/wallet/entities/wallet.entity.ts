import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Balance } from './balance.entity';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Nullable because the system/house wallet has no user.
  // Application code must enforce uniqueness for non-null userIds.
  @Column({ type: 'uuid', unique: true, nullable: true })
  userId!: string | null;

  @Column({ type: 'boolean', default: false })
  isSystem!: boolean;

  @OneToMany(() => Balance, (balance) => balance.wallet)
  balances!: Balance[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
