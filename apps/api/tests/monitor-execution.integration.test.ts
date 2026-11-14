import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

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

const workspaceIds = new Set<string>();

type Fixture = {
  workspaceId: string;
  probeId: string;
  userId: string;
};

async function createFixture(): Promise<Fixture> {
  const userId = `execution-test-${randomUUID()}`;

  const workspaceResult = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name)
     VALUES ($1)
     RETURNING id`,
    [`execution-test-${randomUUID()}`],
  );

  const workspaceId = workspaceResult.rows[0]?.id;

  if (!workspaceId) {
    throw new Error("Failed to create workspace fixture");
  }

  workspaceIds.add(workspaceId);

  await pool.query(
    `INSERT INTO workspace_members (
       workspace_id,
       auth_provider_user_id,
       role
     )
     VALUES ($1, $2, 'owner')`,
    [workspaceId, userId],
  );

  const monitorResult = await pool.query<{ id: string }>(
    `INSERT INTO monitors (
       workspace_id,
       name,
       url,
       interval_seconds,
       timeout_ms
     )
     VALUES ($1, $2, 'https://example.com', 300, 10000)
     RETURNING id`,
    [workspaceId, `execution-monitor-${randomUUID()}`],
  );

  const monitorId = monitorResult.rows[0]?.id;

  if (!monitorId) {
    throw new Error("Failed to create monitor fixture");
  }

  const probeResult = await pool.query<{ id: string }>(
    `INSERT INTO monitor_probes (
       monitor_id,
       region_code
     )
     VALUES ($1, 'ap-south-1')
     RETURNING id`,
    [monitorId],
  );

  const probeId = probeResult.rows[0]?.id;

  if (!probeId) {
    throw new Error("Failed to create probe fixture");
  }

  return { workspaceId, probeId, userId };
}

async function createExecution(
  probeId: string,
  overrides: {
    status?: string;
    scheduledFor?: Date;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    completedAt?: Date | null;
  } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO monitor_executions (
       probe_id,
       scheduled_for,
       status,
       lease_owner,
       lease_expires_at,
       completed_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      probeId,
      overrides.scheduledFor ?? new Date(),
      overrides.status ?? "pending",
      overrides.leaseOwner ?? null,
      overrides.leaseExpiresAt ?? null,
      overrides.completedAt ?? null,
    ],
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error("Failed to create execution fixture");
  }

  return id;
}

async function createOutboxEvent(
  executionId: string,
  overrides: {
    status?: string;
    lockedBy?: string | null;
    leaseExpiresAt?: Date | null;
    publishedAt?: Date | null;
  } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (
       execution_id,
       event_type,
       status,
       locked_by,
       lease_expires_at,
       published_at
     )
     VALUES ($1, 'monitor.check.requested', $2, $3, $4, $5)
     RETURNING id`,
    [
      executionId,
      overrides.status ?? "pending",
      overrides.lockedBy ?? null,
      overrides.leaseExpiresAt ?? null,
      overrides.publishedAt ?? null,
    ],
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error("Failed to create outbox fixture");
  }

  return id;
}

async function createCheck(
  probeId: string,
  executionId: string | null = null,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO monitor_checks (
       probe_id,
       execution_id,
       status,
       checked_at,
       completed_at,
       response_time_ms
     )
     VALUES ($1, $2, 'up', now(), now(), 120)
     RETURNING id`,
    [probeId, executionId],
  );

  const id = result.rows[0]?.id;

  if (!id) {
    throw new Error("Failed to create check fixture");
  }

  return id;
}

describe("Monitor execution and outbox — PostgreSQL invariants", () => {
  beforeAll(async () => {
    const result = await pool.query<{
      database_name: string;
      migration_count: string;
    }>(
      `SELECT
         current_database() AS database_name,
         (SELECT COUNT(*) FROM pgmigrations)::text AS migration_count`,
    );

    const database = result.rows[0];

    if (
      !database ||
      database.database_name !== "nexus_test" ||
      Number(database.migration_count) !== 5
    ) {
      throw new Error("Test database is not correctly migrated");
    }
  });

  afterEach(async () => {
    for (const workspaceId of workspaceIds) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }

    workspaceIds.clear();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("enforces one execution per probe and scheduled slot", async () => {
    const fixture = await createFixture();
    const scheduledFor = new Date("2026-11-07T10:00:00.000Z");

    await createExecution(fixture.probeId, { scheduledFor });

    await expect(
      createExecution(fixture.probeId, { scheduledFor }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires a lease owner and expiry for running executions", async () => {
    const fixture = await createFixture();

    await expect(
      createExecution(fixture.probeId, { status: "running" }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      createExecution(fixture.probeId, {
        status: "running",
        leaseOwner: "worker-1",
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires completed_at for terminal execution states", async () => {
    const fixture = await createFixture();

    await expect(
      createExecution(fixture.probeId, { status: "completed" }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      createExecution(fixture.probeId, {
        status: "completed",
        completedAt: new Date(),
      }),
    ).resolves.toBeTruthy();
  });

  it("requires a lease for publishing outbox events", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    await expect(
      createOutboxEvent(executionId, { status: "publishing" }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      createOutboxEvent(executionId, {
        status: "publishing",
        lockedBy: "publisher-1",
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires published_at for published outbox events", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    await expect(
      createOutboxEvent(executionId, { status: "published" }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      createOutboxEvent(executionId, {
        status: "published",
        publishedAt: new Date(),
      }),
    ).resolves.toBeTruthy();
  });

  it("allows multiple dispatch events for one logical execution", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    const first = await createOutboxEvent(executionId);
    const second = await createOutboxEvent(executionId);

    expect(first).not.toBe(second);

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM outbox_events
       WHERE execution_id = $1`,
      [executionId],
    );

    expect(Number(result.rows[0]?.count)).toBe(2);
  });

  it("enforces one accepted check per execution", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    await createCheck(fixture.probeId, executionId);

    await expect(
      createCheck(fixture.probeId, executionId),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a check linked to an execution belonging to another probe", async () => {
    const firstFixture = await createFixture();
    const secondFixture = await createFixture();

    const executionId = await createExecution(firstFixture.probeId);

    await expect(
      createCheck(secondFixture.probeId, executionId),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("allows legacy checks without an execution_id", async () => {
    const fixture = await createFixture();

    const checkId = await createCheck(fixture.probeId);

    const result = await pool.query<{ execution_id: string | null }>(
      `SELECT execution_id
       FROM monitor_checks
       WHERE id = $1`,
      [checkId],
    );

    expect(result.rows[0]?.execution_id).toBeNull();
  });

  it("prevents deleting an execution while its check history exists", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    await createCheck(fixture.probeId, executionId);

    await expect(
      pool.query("DELETE FROM monitor_executions WHERE id = $1", [executionId]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects lease metadata on non-running executions", async () => {
    const fixture = await createFixture();

    await expect(
      createExecution(fixture.probeId, {
        status: "pending",
        leaseOwner: "worker-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects completed_at on non-terminal executions", async () => {
    const fixture = await createFixture();

    await expect(
      createExecution(fixture.probeId, {
        status: "pending",
        completedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects lease metadata on non-publishing outbox events", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    await expect(
      createOutboxEvent(executionId, {
        status: "pending",
        lockedBy: "publisher-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects outbox events referencing a nonexistent execution", async () => {
    await expect(createOutboxEvent(randomUUID())).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("cascades outbox events when their execution is deleted", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);
    await createOutboxEvent(executionId);

    await pool.query("DELETE FROM monitor_executions WHERE id = $1", [
      executionId,
    ]);

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM outbox_events
       WHERE execution_id = $1`,
      [executionId],
    );

    expect(Number(result.rows[0]?.count)).toBe(0);
  });

  it("cascades probe deletion through checks, executions, and outbox events", async () => {
    const fixture = await createFixture();
    const executionId = await createExecution(fixture.probeId);

    await createOutboxEvent(executionId);
    await createCheck(fixture.probeId, executionId);

    await pool.query("DELETE FROM monitor_probes WHERE id = $1", [
      fixture.probeId,
    ]);

    const result = await pool.query<{
      executions: string;
      outbox_events: string;
      checks: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM monitor_executions WHERE id = $1)::text AS executions,
         (SELECT COUNT(*) FROM outbox_events WHERE execution_id = $1)::text AS outbox_events,
         (SELECT COUNT(*) FROM monitor_checks WHERE probe_id = $2)::text AS checks`,
      [executionId, fixture.probeId],
    );

    expect(result.rows[0]).toEqual({
      executions: "0",
      outbox_events: "0",
      checks: "0",
    });
  });
});
