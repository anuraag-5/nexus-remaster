import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  createSchedulerService,
  InvalidSchedulerBatchSizeError,
} from "../src/scheduler/scheduler.service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\/+/, "");

if (databaseName !== "nexus_test") {
  throw new Error(
    `Integration tests may only run against nexus_test, received: ${databaseName}`,
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 3,
  connectionTimeoutMillis: 5_000,
});

const scheduler = createSchedulerService(pool);

const workspaceIds = new Set<string>();
const temporaryRegionCodes = new Set<string>();

type Fixture = {
  workspaceId: string;
  monitorId: string;
  probeId: string;
};

async function createFixture(
  options: {
    intervalSeconds?: number;
    regionCode?: string;
  } = {},
): Promise<Fixture> {
  const workspaceResult = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name)
     VALUES ($1)
     RETURNING id`,
    [`scheduler-test-${randomUUID()}`],
  );

  const workspaceId = workspaceResult.rows[0]?.id;

  if (!workspaceId) {
    throw new Error("Failed to create scheduler workspace fixture");
  }

  workspaceIds.add(workspaceId);

  const monitorResult = await pool.query<{ id: string }>(
    `INSERT INTO monitors (
       workspace_id,
       name,
       url,
       interval_seconds,
       timeout_ms
     )
     VALUES ($1, $2, 'https://example.com', $3, 10000)
     RETURNING id`,
    [
      workspaceId,
      `scheduler-monitor-${randomUUID()}`,
      options.intervalSeconds ?? 300,
    ],
  );

  const monitorId = monitorResult.rows[0]?.id;

  if (!monitorId) {
    throw new Error("Failed to create scheduler monitor fixture");
  }

  const probeResult = await pool.query<{ id: string }>(
    `INSERT INTO monitor_probes (
       monitor_id,
       region_code
     )
     VALUES ($1, $2)
     RETURNING id`,
    [monitorId, options.regionCode ?? "ap-south-1"],
  );

  const probeId = probeResult.rows[0]?.id;

  if (!probeId) {
    throw new Error("Failed to create scheduler probe fixture");
  }

  return {
    workspaceId,
    monitorId,
    probeId,
  };
}

async function setProbeDue(
  probeId: string,
  nextCheckAt = new Date(Date.now() - 60_000),
): Promise<void> {
  await pool.query(
    `UPDATE monitor_probes
     SET next_check_at = $2
     WHERE id = $1`,
    [probeId, nextCheckAt],
  );
}

async function getProbeSchedule(probeId: string): Promise<Date> {
  const result = await pool.query<{ next_check_at: Date }>(
    `SELECT next_check_at
     FROM monitor_probes
     WHERE id = $1`,
    [probeId],
  );

  const nextCheckAt = result.rows[0]?.next_check_at;

  if (!nextCheckAt) {
    throw new Error("Probe schedule was not found");
  }

  return nextCheckAt;
}

describe("Scheduler service — PostgreSQL integration", () => {
  beforeAll(async () => {
    const result = await pool.query<{
      database_name: string;
      publisher_fencing_column_exists: boolean;
    }>(
      `SELECT
     current_database() AS database_name,
     EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'outbox_events'
         AND column_name = 'publisher_fencing_token'
     ) AS publisher_fencing_column_exists`,
    );

    const database = result.rows[0];

    if (
      !database ||
      database.database_name !== "nexus_test" ||
      !database.publisher_fencing_column_exists
    ) {
      throw new Error(
        "Test database is not nexus_test or is missing the publisher fencing migration",
      );
    }
  });

  afterEach(async () => {
    for (const workspaceId of workspaceIds) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }

    workspaceIds.clear();

    for (const regionCode of temporaryRegionCodes) {
      await pool.query("DELETE FROM monitor_regions WHERE code = $1", [
        regionCode,
      ]);
    }

    temporaryRegionCodes.clear();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates one pending execution and one outbox event for a due probe", async () => {
    const fixture = await createFixture();
    await setProbeDue(fixture.probeId);

    const result = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(result.scheduledCount).toBe(1);

    const persisted = await pool.query<{
      execution_status: string;
      execution_count: string;
      outbox_count: string;
      event_type: string;
      outbox_status: string;
    }>(
      `SELECT
         e.status AS execution_status,
         (
           SELECT COUNT(*)::text
           FROM monitor_executions
           WHERE probe_id = $1
         ) AS execution_count,
         (
           SELECT COUNT(*)::text
           FROM outbox_events
           WHERE execution_id = e.id
         ) AS outbox_count,
         o.event_type,
         o.status AS outbox_status
       FROM monitor_executions AS e
       INNER JOIN outbox_events AS o
         ON o.execution_id = e.id
       WHERE e.probe_id = $1`,
      [fixture.probeId],
    );

    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      execution_status: "pending",
      execution_count: "1",
      outbox_count: "1",
      event_type: "monitor.check.requested",
      outbox_status: "pending",
    });

    const nextCheckAt = await getProbeSchedule(fixture.probeId);

    expect(nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not schedule a probe whose next_check_at is in the future", async () => {
    const fixture = await createFixture();

    const futureTime = new Date(Date.now() + 10 * 60_000);
    await setProbeDue(fixture.probeId, futureTime);

    const result = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(result.scheduledCount).toBe(0);

    const executions = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM monitor_executions
       WHERE probe_id = $1`,
      [fixture.probeId],
    );

    expect(executions.rows[0]?.count).toBe("0");

    const nextCheckAt = await getProbeSchedule(fixture.probeId);

    expect(nextCheckAt.getTime()).toBe(futureTime.getTime());
  });

  it("coalesces missed intervals instead of creating one execution per missed slot", async () => {
    const intervalSeconds = 300;
    const fixture = await createFixture({ intervalSeconds });

    const originalSchedule = new Date("2020-01-01T00:00:00.000Z");
    await setProbeDue(fixture.probeId, originalSchedule);

    const result = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(result.scheduledCount).toBe(1);

    const executionResult = await pool.query<{
      scheduled_for: Date;
    }>(
      `SELECT scheduled_for
       FROM monitor_executions
       WHERE probe_id = $1`,
      [fixture.probeId],
    );

    const scheduledFor = executionResult.rows[0]?.scheduled_for;

    if (!scheduledFor) {
      throw new Error("Expected a scheduled execution");
    }

    const nextCheckAt = await getProbeSchedule(fixture.probeId);

    // The execution represents a real interval boundary anchored to
    // the probe's original schedule, not the scheduler's start time.
    const elapsedMilliseconds =
      scheduledFor.getTime() - originalSchedule.getTime();

    expect(elapsedMilliseconds).toBeGreaterThanOrEqual(0);
    expect(elapsedMilliseconds % (intervalSeconds * 1000)).toBe(0);

    // The next scheduled slot must immediately follow the coalesced slot.
    expect(nextCheckAt.getTime() - scheduledFor.getTime()).toBe(
      intervalSeconds * 1000,
    );

    // The scheduler must advance beyond the current time.
    expect(nextCheckAt.getTime()).toBeGreaterThan(Date.now());

    // A second tick must not create another execution for the same probe.
    const secondResult = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(secondResult.scheduledCount).toBe(0);

    const executionCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM monitor_executions
       WHERE probe_id = $1`,
      [fixture.probeId],
    );

    expect(executionCount.rows[0]?.count).toBe("1");
  });

  it("does not schedule probes belonging to disabled monitors", async () => {
    const fixture = await createFixture();

    await setProbeDue(fixture.probeId);

    await pool.query(
      `UPDATE monitors
       SET is_enabled = FALSE
       WHERE id = $1`,
      [fixture.monitorId],
    );

    const result = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(result.scheduledCount).toBe(0);

    const executions = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM monitor_executions
       WHERE probe_id = $1`,
      [fixture.probeId],
    );

    expect(executions.rows[0]?.count).toBe("0");
  });

  it("does not schedule disabled probes", async () => {
    const fixture = await createFixture();

    await setProbeDue(fixture.probeId);

    await pool.query(
      `UPDATE monitor_probes
       SET is_enabled = FALSE
       WHERE id = $1`,
      [fixture.probeId],
    );

    const result = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(result.scheduledCount).toBe(0);
  });

  it("does not schedule probes belonging to disabled regions", async () => {
    const regionCode = `test-${randomUUID()}`;

    await pool.query(
      `INSERT INTO monitor_regions (
         code,
         country_code,
         display_name,
         is_enabled
       )
       VALUES ($1, 'ZZ', 'Scheduler Test Region', FALSE)`,
      [regionCode],
    );

    temporaryRegionCodes.add(regionCode);

    const fixture = await createFixture({ regionCode });
    await setProbeDue(fixture.probeId);

    const result = await scheduler.scheduleDueProbes({
      batchSize: 10,
    });

    expect(result.scheduledCount).toBe(0);
  });

  it("uses SKIP LOCKED to schedule another available probe without waiting", async () => {
    const lockedFixture = await createFixture();
    const availableFixture = await createFixture();

    // Make the locked probe older so it sorts first.
    await setProbeDue(lockedFixture.probeId, new Date(Date.now() - 5 * 60_000));

    await setProbeDue(availableFixture.probeId, new Date(Date.now() - 60_000));

    const lockClient = await pool.connect();

    try {
      await lockClient.query("BEGIN");

      await lockClient.query(
        `SELECT id
         FROM monitor_probes
         WHERE id = $1
         FOR UPDATE`,
        [lockedFixture.probeId],
      );

      // The scheduler must skip the locked row and process the other probe.
      const result = await scheduler.scheduleDueProbes({
        batchSize: 1,
      });

      expect(result.scheduledCount).toBe(1);

      const scheduled = await pool.query<{ probe_id: string }>(
        `SELECT probe_id
         FROM monitor_executions
         WHERE probe_id = ANY($1::uuid[])`,
        [[lockedFixture.probeId, availableFixture.probeId]],
      );

      expect(scheduled.rows).toEqual([{ probe_id: availableFixture.probeId }]);
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });

  it("does not create duplicate executions when two scheduler instances run concurrently", async () => {
    const fixture = await createFixture();
    await setProbeDue(fixture.probeId);

    const [first, second] = await Promise.all([
      scheduler.scheduleDueProbes({ batchSize: 10 }),
      scheduler.scheduleDueProbes({ batchSize: 10 }),
    ]);

    expect(first.scheduledCount + second.scheduledCount).toBe(1);

    const result = await pool.query<{
      executions: string;
      outbox_events: string;
    }>(
      `SELECT
         (
           SELECT COUNT(*)::text
           FROM monitor_executions
           WHERE probe_id = $1
         ) AS executions,
         (
           SELECT COUNT(*)::text
           FROM outbox_events AS o
           INNER JOIN monitor_executions AS e
             ON e.id = o.execution_id
           WHERE e.probe_id = $1
         ) AS outbox_events`,
      [fixture.probeId],
    );

    expect(result.rows[0]).toEqual({
      executions: "1",
      outbox_events: "1",
    });
  });

  it("rejects invalid scheduler batch sizes", async () => {
    const invalidBatchSizes = [0, -1, 1.5, 501, Number.NaN];

    for (const batchSize of invalidBatchSizes) {
      await expect(
        scheduler.scheduleDueProbes({ batchSize }),
      ).rejects.toBeInstanceOf(InvalidSchedulerBatchSizeError);
    }
  });

  it("rolls back execution creation and schedule advancement when outbox insertion fails", async () => {
    const fixture = await createFixture();

    const originalSchedule = new Date(Date.now() - 60_000);
    await setProbeDue(fixture.probeId, originalSchedule);

    // Use generated identifiers so this trigger is isolated to this test.
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `scheduler_reject_outbox_${suffix}`;
    const triggerName = `scheduler_reject_outbox_${suffix}`;

    let functionCreated = false;
    let triggerCreated = false;

    try {
      await pool.query(`
      CREATE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM monitor_executions
          WHERE id = NEW.execution_id
            AND probe_id = '${fixture.probeId}'::uuid
        ) THEN
          RAISE EXCEPTION 'Intentional scheduler integration-test failure'
            USING ERRCODE = 'P0001';
        END IF;

        RETURN NEW;
      END;
      $function$;
    `);

      functionCreated = true;

      await pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON outbox_events
      FOR EACH ROW
      EXECUTE FUNCTION ${functionName}();
    `);

      triggerCreated = true;

      await expect(
        scheduler.scheduleDueProbes({ batchSize: 10 }),
      ).rejects.toMatchObject({
        code: "P0001",
      });

      const persisted = await pool.query<{
        executions: string;
        outbox_events: string;
      }>(
        `SELECT
         (
           SELECT COUNT(*)::text
           FROM monitor_executions
           WHERE probe_id = $1
         ) AS executions,
         (
           SELECT COUNT(*)::text
           FROM outbox_events AS o
           INNER JOIN monitor_executions AS e
             ON e.id = o.execution_id
           WHERE e.probe_id = $1
         ) AS outbox_events`,
        [fixture.probeId],
      );

      expect(persisted.rows[0]).toEqual({
        executions: "0",
        outbox_events: "0",
      });

      const scheduleAfterFailure = await getProbeSchedule(fixture.probeId);

      expect(scheduleAfterFailure.getTime()).toBe(originalSchedule.getTime());
    } finally {
      if (triggerCreated) {
        await pool.query(`DROP TRIGGER ${triggerName} ON outbox_events`);
      }

      if (functionCreated) {
        await pool.query(`DROP FUNCTION ${functionName}()`);
      }
    }
  });
});
