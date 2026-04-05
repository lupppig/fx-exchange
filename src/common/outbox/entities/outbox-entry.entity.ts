import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum OutboxStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

@Entity('outbox_entries')
@Index(['status', 'createdAt'])
export class OutboxEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: false })
  eventType!: string;

  @Column({ type: 'jsonb', nullable: false })
  payload!: Record<string, unknown>;

  @Column({ type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  @Column({ default: 0 })
  retryCount!: number;

  @Column({ nullable: true })
  lastError!: string | null;

  @Column({ nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
