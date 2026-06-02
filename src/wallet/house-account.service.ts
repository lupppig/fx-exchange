import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryRunner, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { Balance } from './entities/balance.entity';

/**
 * Sentinel UUID used on the `userId` column of ledger rows owned by the
 * house. The house WALLET has userId = NULL (no real user), but ledger
 * tables still require uuid NOT NULL so we use the nil UUID as a fixed,
 * obvious marker. Application code should never look it up against users.
 */
export const HOUSE_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The house account is the counterparty to every user-facing financial
 * operation. It is seeded once by migration and never replaced.
 *
 * This service exposes:
 *   - the (cached) house wallet id, resolved at boot
 *   - SELECT ... FOR UPDATE helpers for the house's balance row in a
 *     given currency, used inside the same DB transaction as the user leg
 *
 * The helpers intentionally do not commit -- they receive the active
 * queryRunner so the house and user legs land atomically.
 */
@Injectable()
export class HouseAccountService implements OnModuleInit {
  private readonly logger = new Logger(HouseAccountService.name);
  private houseWalletId: string | null = null;

  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
  ) {}

  async onModuleInit(): Promise<void> {
    const house = await this.walletRepo.findOne({ where: { isSystem: true } });
    if (!house) {
      // Surfacing this at boot is intentional: if the seed migration didn't
      // run, every funding and conversion would silently book against the
      // user instead of the house. Better to fail to start.
      throw new InternalServerErrorException(
        'House wallet missing -- did the HouseAccount migration run?',
      );
    }
    this.houseWalletId = house.id;
    this.logger.log(`House wallet resolved: ${house.id}`);
  }

  getId(): string {
    if (!this.houseWalletId) {
      throw new InternalServerErrorException('House wallet not initialized');
    }
    return this.houseWalletId;
  }

  /**
   * Lock the house's balance row for `currency` for the duration of the
   * supplied transaction. Returns the row with `amount` as a number string
   * (TypeORM bigint behavior); callers should pass it through Number() or
   * BigInt() as appropriate.
   *
   * Throws if the row doesn't exist -- house balances are seeded for every
   * supported currency by migration, so a missing row is a bug.
   */
  async lockBalance(
    queryRunner: QueryRunner,
    currency: string,
  ): Promise<Balance> {
    const houseId = this.getId();
    const balance = await queryRunner.manager
      .createQueryBuilder(Balance, 'balance')
      .setLock('pessimistic_write')
      .where('balance.walletId = :walletId AND balance.currency = :currency', {
        walletId: houseId,
        currency,
      })
      .getOne();

    if (!balance) {
      throw new InternalServerErrorException(
        `House balance for ${currency} missing -- seed migration incomplete`,
      );
    }
    return balance;
  }
}
