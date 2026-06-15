import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Orders table.
 *
 * A row exists for every attempted trade -- one per RFQ acceptance -- so
 * we can answer "which quote did the user accept and what rate did they
 * actually execute at?" without spelunking the ledger. The balance/ledger
 * remain the source of truth for value; orders are the source of truth
 * for the trade lifecycle.
 */
export class Orders1748880001000 implements MigrationInterface {
  name = 'Orders1748880001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."orders_type_enum" AS ENUM('MARKET')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('PENDING', 'FILLED', 'REJECTED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "fromCurrency" character varying(3) NOT NULL,
        "toCurrency" character varying(3) NOT NULL,
        "amountInSubunits" bigint NOT NULL,
        "amountOutSubunits" bigint NOT NULL,
        "type" "public"."orders_type_enum" NOT NULL DEFAULT 'MARKET',
        "status" "public"."orders_status_enum" NOT NULL DEFAULT 'PENDING',
        "quoteId" uuid,
        "executedRate" numeric(18,10),
        "journalEntryId" uuid,
        "rejectionReason" text,
        "filledAt" timestamp,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_orders_amountIn_pos" CHECK ("amountInSubunits" > 0),
        CONSTRAINT "CHK_orders_amountOut_pos" CHECK ("amountOutSubunits" > 0),
        CONSTRAINT "PK_orders" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_orders_userId" ON "orders" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_status" ON "orders" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_quoteId" ON "orders" ("quoteId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_journalEntryId" ON "orders" ("journalEntryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_createdAt" ON "orders" ("createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_orders_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_orders_journalEntryId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_orders_quoteId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_orders_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_orders_userId"`,
    );
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."orders_type_enum"`);
  }
}
