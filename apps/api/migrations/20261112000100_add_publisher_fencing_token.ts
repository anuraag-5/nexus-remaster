import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE outbox_events
      ADD COLUMN publisher_fencing_token BIGINT NOT NULL DEFAULT 0,
      ADD CONSTRAINT outbox_events_publisher_fencing_token_nonnegative
        CHECK (publisher_fencing_token >= 0);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE outbox_events
      DROP CONSTRAINT IF EXISTS
        outbox_events_publisher_fencing_token_nonnegative,
      DROP COLUMN IF EXISTS publisher_fencing_token;
  `);
}
