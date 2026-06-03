import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum OutboxStatus {
  /** Newly written, awaiting pickup. */
  PENDING = 'PENDING',
  /** Claimed by a processor instance; visible to recovery sweep if stale. */
  PROCESSING = 'PROCESSING',
  /** Successfully published to the broker. Terminal. */
  PUBLISHED = 'PUBLISHED',
  /** Retries exhausted -- dead letter. Terminal. */
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

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  publishedAt!: Date | null;

  /**
   * Set when a processor flips this row to PROCESSING. The recovery sweep
   * uses it to detect rows abandoned by a crashed replica (claimedAt older
   * than the stale threshold) and revert them to PENDING.
   */
  @Column({ type: 'timestamp', nullable: true })
  claimedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
