import { MigrationInterface, QueryRunner } from 'typeorm';

const SUPPORTED_CURRENCIES = [
  'NGN', 'USD', 'EUR', 'GBP', 'CAD', 'AUD',
  'CHF', 'JPY', 'CNY', 'ZAR', 'KES', 'GHS',
];

/**
 * House account migration.
 *
 * Every trade in a real FX broker has a counterparty. Up to this point the
 * "external funding source" leg was a fake user-to-self entry, which made
 * the ledger formally balanced but not economically meaningful. This
 * migration introduces a single system-owned wallet -- the house -- that
 * stands on the other side of every funding and every conversion:
 *
 *   Funding:  house DEBIT(ccy)  + user CREDIT(ccy)
 *   Convert:  user  DEBIT(from) + house CREDIT(from)
 *             + house DEBIT(to)  + user  CREDIT(to)
 *
 * The house wallet is seeded with a large balance per currency so it can
 * fund users; any drift between expected and actual balance becomes a
 * real signal of a bug rather than being hidden by zero-amount counter-legs.
 */
export class HouseAccount1748880000000 implements MigrationInterface {
  name = 'HouseAccount1748880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // userId must be nullable for the system wallet, and the type wants to be
    // uuid for consistency with users.id (and so FK refs work).
    await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "userId" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "wallets" ADD COLUMN "isSystem" boolean NOT NULL DEFAULT false`);

    // One and only one system wallet -- enforce by partial unique index.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_wallets_system_singleton" ON "wallets" (("isSystem")) WHERE "isSystem" = true`,
    );

    // Insert the house wallet and capture its id so we can seed balances.
    const inserted: Array<{ id: string }> = await queryRunner.query(
      `INSERT INTO "wallets" ("userId", "isSystem") VALUES (NULL, true) RETURNING "id"`,
    );
    const houseWalletId = inserted[0].id;

    // 9e15 subunits ≈ 90 trillion in major units -- enough headroom that the
    // house can fund all foreseeable test/load traffic without going negative,
    // and well under bigint max (9.22e18).
    const SEED = '9000000000000000';
    for (const ccy of SUPPORTED_CURRENCIES) {
      await queryRunner.query(
        `INSERT INTO "balances" ("walletId", "currency", "amount") VALUES ($1, $2, $3)`,
        [houseWalletId, ccy, SEED],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "balances" WHERE "walletId" IN (SELECT "id" FROM "wallets" WHERE "isSystem" = true)`,
    );
    await queryRunner.query(`DELETE FROM "wallets" WHERE "isSystem" = true`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_wallets_system_singleton"`);
    await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "isSystem"`);
    await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "userId" SET NOT NULL`);
  }
}
