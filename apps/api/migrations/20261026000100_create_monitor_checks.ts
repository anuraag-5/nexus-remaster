import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE monitor_checks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      monitor_id UUID NOT NULL
        REFERENCES monitors(id)
        ON DELETE CASCADE,

      status TEXT NOT NULL
        CHECK (status IN ('up', 'down')),

      checked_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,

      response_time_ms INTEGER NOT NULL
        CHECK (response_time_ms >= 0),

      http_status_code INTEGER
        CHECK (
          http_status_code IS NULL
          OR http_status_code BETWEEN 100 AND 599
        ),

      error_code TEXT
        CHECK (
          error_code IS NULL OR length(error_code) <= 100
        ),

      error_message TEXT
        CHECK (
          error_message IS NULL OR length(error_message) <= 500
        )
    );

    CREATE INDEX monitor_checks_monitor_checked_idx
      ON monitor_checks (monitor_id, checked_at DESC);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP TABLE IF EXISTS monitor_checks;
  `);
}