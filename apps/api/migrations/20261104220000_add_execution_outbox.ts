import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- One durable record per logical scheduled monitoring execution.
    -- Redis/BullMQ delivery attempts are not separate executions.
    CREATE TABLE monitor_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      probe_id UUID NOT NULL
        REFERENCES monitor_probes(id)
        ON DELETE CASCADE,

      scheduled_for TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
          status IN (
            'pending',
            'queued',
            'running',
            'completed',
            'failed',
            'cancelled'
          )
        ),

      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

      max_attempts INTEGER NOT NULL DEFAULT 3
        CHECK (max_attempts >= 1),

      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,

      -- Incremented every time a worker successfully claims this execution.
      -- A worker holding an older token cannot commit a result.
      fencing_token BIGINT NOT NULL DEFAULT 0
        CHECK (fencing_token >= 0),

      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,

      last_error_code TEXT
        CHECK (
          last_error_code IS NULL
          OR char_length(last_error_code) <= 100
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT monitor_executions_probe_schedule_unique
        UNIQUE (probe_id, scheduled_for),

      -- Required as the target of the composite FK from monitor_checks.
      CONSTRAINT monitor_executions_id_probe_unique
        UNIQUE (id, probe_id),

      -- A running execution must have a complete lease.
      -- Non-running executions must not retain a lease.
      CONSTRAINT monitor_executions_lease_consistency
        CHECK (
          (
            status = 'running'
            AND lease_owner IS NOT NULL
            AND char_length(btrim(lease_owner)) > 0
            AND lease_expires_at IS NOT NULL
          )
          OR
          (
            status <> 'running'
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
          )
        ),

      CONSTRAINT monitor_executions_terminal_timestamp
        CHECK (
          (
            status IN ('completed', 'failed', 'cancelled')
            AND completed_at IS NOT NULL
          )
          OR
          (
            status IN ('pending', 'queued', 'running')
            AND completed_at IS NULL
          )
        )
    );

    -- Scheduler and retry eligibility.
    CREATE INDEX monitor_executions_available_idx
      ON monitor_executions (available_at, created_at)
      WHERE status IN ('pending', 'queued');

    -- Expired worker leases must be recoverable.
    CREATE INDEX monitor_executions_expired_lease_idx
      ON monitor_executions (lease_expires_at)
      WHERE status = 'running';

    CREATE INDEX monitor_executions_probe_history_idx
      ON monitor_executions (probe_id, scheduled_for DESC);


    -- Durable dispatch intent.
    -- Multiple events may reference one execution after recovery.
    CREATE TABLE outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      execution_id UUID NOT NULL
        REFERENCES monitor_executions(id)
        ON DELETE CASCADE,

      event_type TEXT NOT NULL
        CHECK (
          char_length(btrim(event_type)) BETWEEN 1 AND 100
        ),

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
          status IN ('pending', 'publishing', 'published')
        ),

      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      publish_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (publish_attempts >= 0),

      locked_by TEXT,
      lease_expires_at TIMESTAMPTZ,

      published_at TIMESTAMPTZ,

      last_error TEXT
        CHECK (
          last_error IS NULL
          OR char_length(last_error) <= 1000
        ),

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT outbox_events_lease_consistency
        CHECK (
          (
            status = 'publishing'
            AND locked_by IS NOT NULL
            AND char_length(btrim(locked_by)) > 0
            AND lease_expires_at IS NOT NULL
          )
          OR
          (
            status <> 'publishing'
            AND locked_by IS NULL
            AND lease_expires_at IS NULL
          )
        ),

      CONSTRAINT outbox_events_published_timestamp
        CHECK (
          (status = 'published' AND published_at IS NOT NULL)
          OR
          (status <> 'published' AND published_at IS NULL)
        )
    );

    -- Pending events ready for publication.
    CREATE INDEX outbox_events_pending_idx
      ON outbox_events (available_at, created_at)
      WHERE status = 'pending';

    -- Publisher crashes must not strand publishing events.
    CREATE INDEX outbox_events_expired_lease_idx
      ON outbox_events (lease_expires_at)
      WHERE status = 'publishing';

    CREATE INDEX outbox_events_execution_idx
      ON outbox_events (execution_id);


    -- Existing monitoring history remains valid.
    -- Historical rows retain NULL execution_id.
    ALTER TABLE monitor_checks
      ADD COLUMN execution_id UUID;

    -- Enforce that the execution and check belong to the same probe.
    -- Deferred NO ACTION prevents execution deletion from silently
    -- deleting historical monitoring results.
    ALTER TABLE monitor_checks
      ADD CONSTRAINT monitor_checks_execution_probe_fkey
      FOREIGN KEY (execution_id, probe_id)
      REFERENCES monitor_executions (id, probe_id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;

    -- At most one accepted monitoring result per logical execution.
    CREATE UNIQUE INDEX monitor_checks_execution_unique_idx
      ON monitor_checks (execution_id)
      WHERE execution_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS monitor_checks_execution_unique_idx;

    ALTER TABLE monitor_checks
      DROP CONSTRAINT IF EXISTS monitor_checks_execution_probe_fkey;

    ALTER TABLE monitor_checks
      DROP COLUMN IF EXISTS execution_id;

    DROP TABLE IF EXISTS outbox_events;
    DROP TABLE IF EXISTS monitor_executions;
  `);
}
