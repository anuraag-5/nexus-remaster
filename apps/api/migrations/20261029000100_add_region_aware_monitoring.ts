import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    -- A catalog of regions where Nexus can run monitoring probes.
    CREATE TABLE monitor_regions (
      code TEXT PRIMARY KEY,
      country_code TEXT NOT NULL
        CHECK (country_code ~ '^[A-Z]{2}$'),
      display_name TEXT NOT NULL
        CHECK (
          char_length(btrim(display_name)) BETWEEN 1 AND 100
        ),
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO monitor_regions (
      code,
      country_code,
      display_name
    )
    VALUES
      ('ap-south-1', 'IN', 'Mumbai, India'),
      ('us-east-1', 'US', 'N. Virginia, USA');

    -- Each monitor gets independent execution state per region.
    CREATE TABLE monitor_probes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      monitor_id UUID NOT NULL
        REFERENCES monitors(id)
        ON DELETE CASCADE,

      region_code TEXT NOT NULL
        REFERENCES monitor_regions(code)
        ON DELETE RESTRICT,

      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

      current_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
          current_status IN ('unknown', 'up', 'down')
        ),

      next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_checked_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT monitor_probes_monitor_region_unique
        UNIQUE (monitor_id, region_code)
    );

    -- Supports finding due probes for a specific region.
    CREATE INDEX monitor_probes_due_idx
      ON monitor_probes (region_code, next_check_at)
      WHERE is_enabled = TRUE;

    -- Backfill existing monitors with both initial regions.
    INSERT INTO monitor_probes (monitor_id, region_code)
    SELECT m.id, r.code
    FROM monitors AS m
    CROSS JOIN monitor_regions AS r
    WHERE r.code IN ('ap-south-1', 'us-east-1')
    ON CONFLICT (monitor_id, region_code) DO NOTHING;

    -- Associate existing history with its India probe so that
    -- existing results are preserved during the schema change.
    ALTER TABLE monitor_checks
      ADD COLUMN probe_id UUID;

    ALTER TABLE monitor_checks
      ADD CONSTRAINT monitor_checks_probe_id_fkey
      FOREIGN KEY (probe_id)
      REFERENCES monitor_probes(id)
      ON DELETE CASCADE;

    UPDATE monitor_checks AS c
    SET probe_id = p.id
    FROM monitor_probes AS p
    WHERE p.monitor_id = c.monitor_id
      AND p.region_code = 'ap-south-1';

    ALTER TABLE monitor_checks
      ALTER COLUMN probe_id SET NOT NULL;

    DROP INDEX monitor_checks_monitor_checked_idx;

    ALTER TABLE monitor_checks
      DROP CONSTRAINT IF EXISTS monitor_checks_monitor_id_fkey;

    ALTER TABLE monitor_checks
      DROP COLUMN monitor_id;

    CREATE INDEX monitor_checks_probe_checked_idx
      ON monitor_checks (probe_id, checked_at DESC);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    -- Restore the previous history relationship on rollback.
    DROP INDEX IF EXISTS monitor_checks_probe_checked_idx;

    ALTER TABLE monitor_checks
      ADD COLUMN monitor_id UUID;

    UPDATE monitor_checks AS c
    SET monitor_id = p.monitor_id
    FROM monitor_probes AS p
    WHERE p.id = c.probe_id;

    ALTER TABLE monitor_checks
      ALTER COLUMN monitor_id SET NOT NULL;

    ALTER TABLE monitor_checks
      ADD CONSTRAINT monitor_checks_monitor_id_fkey
      FOREIGN KEY (monitor_id)
      REFERENCES monitors(id)
      ON DELETE CASCADE;

    ALTER TABLE monitor_checks
      DROP CONSTRAINT IF EXISTS monitor_checks_probe_id_fkey;

    ALTER TABLE monitor_checks
      DROP COLUMN probe_id;

    CREATE INDEX monitor_checks_monitor_checked_idx
      ON monitor_checks (monitor_id, checked_at DESC);

    DROP TABLE monitor_probes;
    DROP TABLE monitor_regions;
  `);
}
