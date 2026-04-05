import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxTable1743897600000 implements MigrationInterface {
  name = 'AddOutboxTable1743897600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."outbox_entries_status_enum" AS ENUM('PENDING', 'PUBLISHED', 'FAILED')
    `);

    await queryRunner.query(`
      CREATE TABLE "outbox_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "eventType" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "public"."outbox_entries_status_enum" NOT NULL DEFAULT 'PENDING',
        "retryCount" integer NOT NULL DEFAULT 0,
        "lastError" character varying,
        "publishedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbox_entries" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_entries_status_createdAt" ON "outbox_entries" ("status", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_outbox_entries_status_createdAt"`,
    );
    await queryRunner.query(`DROP TABLE "outbox_entries"`);
    await queryRunner.query(`DROP TYPE "public"."outbox_entries_status_enum"`);
  }
}
