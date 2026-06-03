import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add PROCESSING state to outbox_entries_status enum and a claimedAt column
 * so the processor can claim rows atomically with
 * SELECT ... FOR UPDATE SKIP LOCKED and the recovery sweep
 * (see OutboxProcessor.recoverStuckEntries) can detect rows abandoned by
 * a crashed replica via age of claimedAt.
 */
export class OutboxProcessing1748880002000 implements MigrationInterface {
  name = 'OutboxProcessing1748880002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."outbox_entries_status_enum" ADD VALUE IF NOT EXISTS 'PROCESSING' BEFORE 'PUBLISHED'`,
    );

    await queryRunner.query(
      `ALTER TABLE "outbox_entries" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres does not support removing enum values without rebuilding
    // the type. PROCESSING rows would also need a fallback. We keep the
    // enum value if down() ever runs -- this is a forward-compatible no-op
    // for the enum -- but we can drop the column cleanly.
    await queryRunner.query(
      `ALTER TABLE "outbox_entries" DROP COLUMN IF EXISTS "claimedAt"`,
    );
  }
}
