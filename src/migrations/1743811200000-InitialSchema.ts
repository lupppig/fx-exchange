import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1743811200000 implements MigrationInterface {
  name = 'InitialSchema1743811200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TYPE "public"."user_role_enum" AS ENUM('USER', 'ADMIN')
    `);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "passwordHash" character varying NOT NULL,
        "isVerified" boolean NOT NULL DEFAULT false,
        "role" "public"."user_role_enum" NOT NULL DEFAULT 'USER',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_wallets_userId" UNIQUE ("userId"),
        CONSTRAINT "PK_wallets" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "balances" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" character varying NOT NULL,
        "currency" character varying(3) NOT NULL,
        "amount" bigint NOT NULL DEFAULT '0',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_balances_walletId_currency" UNIQUE ("walletId", "currency"),
        CONSTRAINT "CHK_balances_amount_non_negative" CHECK ("amount" >= 0),
        CONSTRAINT "CHK_balances_currency_length" CHECK (length("currency") = 3),
        CONSTRAINT "PK_balances" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_balances_walletId" ON "balances" ("walletId")
    `);

    await queryRunner.query(`
      ALTER TABLE "balances"
      ADD CONSTRAINT "FK_balances_walletId"
      FOREIGN KEY ("walletId") REFERENCES "wallets"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."journal_entries_purpose_enum" AS ENUM('FUNDING', 'EXCHANGE', 'TRADE')
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."journal_entries_status_enum" AS ENUM('PENDING', 'SUCCESS', 'FAILED')
    `);

    await queryRunner.query(`
      CREATE TABLE "journal_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "purpose" "public"."journal_entries_purpose_enum" NOT NULL,
        "status" "public"."journal_entries_status_enum" NOT NULL DEFAULT 'PENDING',
        "idempotencyKey" character varying NOT NULL,
        "exchangeRate" numeric(18,8),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_journal_entries_userId_idempotencyKey" UNIQUE ("userId", "idempotencyKey"),
        CONSTRAINT "CHK_journal_entries_exchangeRate" CHECK ("exchangeRate" IS NULL OR "exchangeRate" > 0),
        CONSTRAINT "PK_journal_entries" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_journal_entries_walletId" ON "journal_entries" ("walletId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_journal_entries_userId" ON "journal_entries" ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_journal_entries_purpose" ON "journal_entries" ("purpose")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_journal_entries_createdAt" ON "journal_entries" ("createdAt")
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."transaction_logs_type_enum" AS ENUM('CREDIT', 'DEBIT')
    `);

    await queryRunner.query(`
      CREATE TABLE "transaction_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "journalEntryId" uuid NOT NULL,
        "walletId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "type" "public"."transaction_logs_type_enum" NOT NULL,
        "currency" character varying(3) NOT NULL,
        "amount" bigint NOT NULL,
        "balanceBefore" bigint NOT NULL,
        "balanceAfter" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_transaction_logs_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "CHK_transaction_logs_balanceBefore" CHECK ("balanceBefore" >= 0),
        CONSTRAINT "CHK_transaction_logs_balanceAfter" CHECK ("balanceAfter" >= 0),
        CONSTRAINT "CHK_transaction_logs_currency_length" CHECK (length("currency") = 3),
        CONSTRAINT "PK_transaction_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_logs_journalEntryId" ON "transaction_logs" ("journalEntryId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_logs_walletId" ON "transaction_logs" ("walletId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_logs_userId" ON "transaction_logs" ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_logs_type" ON "transaction_logs" ("type")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_logs_currency" ON "transaction_logs" ("currency")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_logs_createdAt" ON "transaction_logs" ("createdAt")
    `);

    await queryRunner.query(`
      ALTER TABLE "transaction_logs"
      ADD CONSTRAINT "FK_transaction_logs_journalEntryId"
      FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transaction_logs" DROP CONSTRAINT "FK_transaction_logs_journalEntryId"
    `);

    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_logs_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_logs_currency"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_transaction_logs_type"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_logs_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_logs_walletId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_logs_journalEntryId"`,
    );

    await queryRunner.query(`DROP TABLE "transaction_logs"`);
    await queryRunner.query(`DROP TYPE "public"."transaction_logs_type_enum"`);

    await queryRunner.query(
      `DROP INDEX "public"."IDX_journal_entries_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_journal_entries_purpose"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_journal_entries_userId"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_journal_entries_walletId"`,
    );

    await queryRunner.query(`DROP TABLE "journal_entries"`);
    await queryRunner.query(`DROP TYPE "public"."journal_entries_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."journal_entries_purpose_enum"`,
    );

    await queryRunner.query(`
      ALTER TABLE "balances" DROP CONSTRAINT "FK_balances_walletId"
    `);

    await queryRunner.query(`DROP INDEX "public"."IDX_balances_walletId"`);
    await queryRunner.query(`DROP TABLE "balances"`);
    await queryRunner.query(`DROP TABLE "wallets"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."user_role_enum"`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS "uuid-ossp"`);
  }
}
