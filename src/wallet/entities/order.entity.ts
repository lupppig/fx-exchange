import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from 'typeorm';

export enum OrderType {
  MARKET = 'MARKET',
  // Limit / stop / OCO live here later. The lifecycle enum below already
  // accommodates open->filled / cancelled transitions so we don't need to
  // re-migrate when those land.
}

export enum OrderStatus {
  /** Created but not yet executed -- only ever observed mid-transaction in MARKET. */
  PENDING = 'PENDING',
  /** Fully matched/executed against the house. Terminal. */
  FILLED = 'FILLED',
  /** Rejected pre-execution (insufficient balance, expired quote, etc). Terminal. */
  REJECTED = 'REJECTED',
}

/**
 * One row per attempted trade. The row is the durable record of the
 * trade lifecycle and the link between the quote that was accepted and
 * the journal entry that records the ledger movements.
 *
 * The wallet, journal, and balances are the source of truth for value;
 * the order row exists so we can answer "did the user actually execute
 * quote X, and at what rate?" without scanning the ledger.
 */
@Entity('orders')
@Check(`"amountInSubunits" > 0`)
@Check(`"amountOutSubunits" > 0`)
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ length: 3 })
  fromCurrency!: string;

  @Column({ length: 3 })
  toCurrency!: string;

  @Column({ type: 'bigint' })
  amountInSubunits!: string;

  @Column({ type: 'bigint' })
  amountOutSubunits!: string;

  @Column({ type: 'enum', enum: OrderType, default: OrderType.MARKET })
  type!: OrderType;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  @Index()
  status!: OrderStatus;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  quoteId!: string | null;

  /** Locked rate from the quote, persisted as decimal(18,10). */
  @Column({ type: 'decimal', precision: 18, scale: 10, nullable: true })
  executedRate!: string | null;

  /** FK-like reference to the journal entry that booked the four ledger legs. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  journalEntryId!: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  filledAt!: Date | null;

  @CreateDateColumn()
  @Index()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
