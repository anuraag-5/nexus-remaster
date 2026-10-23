import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE workspaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE workspace_members (
      workspace_id UUID NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE,
      auth_provider_user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (workspace_id, auth_provider_user_id)
    )
  `);

  pgm.sql(`
    CREATE INDEX workspace_members_user_idx
      ON workspace_members (auth_provider_user_id)
  `);

  pgm.sql(`
    CREATE TABLE monitors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
      url TEXT NOT NULL
        CHECK (char_length(url) BETWEEN 8 AND 2048),
      interval_seconds INTEGER NOT NULL DEFAULT 300
        CHECK (interval_seconds BETWEEN 30 AND 86400),
      timeout_ms INTEGER NOT NULL DEFAULT 10000
        CHECK (timeout_ms BETWEEN 1000 AND 60000),
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      current_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (current_status IN ('unknown', 'up', 'down')),
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE INDEX monitors_due_check_idx
      ON monitors (next_check_at)
      WHERE is_enabled = TRUE
  `);

  pgm.sql(`
    CREATE INDEX monitors_workspace_created_idx
      ON monitors (workspace_id, created_at DESC)
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql("DROP TABLE monitors");
  pgm.sql("DROP TABLE workspace_members");
  pgm.sql("DROP TABLE workspaces");
}