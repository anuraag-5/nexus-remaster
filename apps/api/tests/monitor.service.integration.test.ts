import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  createMonitorService,
  InvalidMonitorRegionsError,
  WorkspaceAccessError,
} from "../src/monitors/monitor.service.js";

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

const monitorService = createMonitorService(pool);
const workspaceIds = new Set<string>();

type WorkspaceFixture = {
  workspaceId: string;
  userId: string;
};

async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const userId = `integration-user-${randomUUID()}`;

  const workspaceResult = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name)
     VALUES ($1)
     RETURNING id`,
    [`integration-${randomUUID()}`],
  );

  const workspace = workspaceResult.rows[0];

  if (!workspace) {
    throw new Error("Failed to create integration-test workspace");
  }

  workspaceIds.add(workspace.id);

  await pool.query(
    `INSERT INTO workspace_members (
       workspace_id,
       auth_provider_user_id,
       role
     )
     VALUES ($1, $2, 'owner')`,
    [workspace.id, userId],
  );

  return {
    workspaceId: workspace.id,
    userId,
  };
}

function makeMonitorInput(
  fixture: WorkspaceFixture,
  overrides: Partial<{
    name: string;
    regionCodes: string[];
  }> = {},
) {
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    name: overrides.name ?? `integration-monitor-${randomUUID()}`,
    url: "https://example.com",
    intervalSeconds: 300,
    timeoutMs: 10_000,
    regionCodes: overrides.regionCodes ?? ["ap-south-1", "us-east-1"],
  };
}

describe("Monitor service — PostgreSQL integration", () => {
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

    if (!database || database.database_name !== "nexus_test") {
      throw new Error("Connected to the wrong database");
    }

    if (Number(database.migration_count) !== 4) {
      throw new Error(
        `Expected 4 migrations, found ${database.migration_count}`,
      );
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

  it("creates a monitor with India and USA probes", async () => {
    const fixture = await createWorkspaceFixture();
    const input = makeMonitorInput(fixture);

    const monitor = await monitorService.createMonitor(input);

    expect(monitor.id).toBeTruthy();
    expect(monitor.workspaceId).toBe(fixture.workspaceId);
    expect(monitor.currentStatus).toBe("unknown");

    const probes = await pool.query<{ region_code: string }>(
      `SELECT region_code
       FROM monitor_probes
       WHERE monitor_id = $1
       ORDER BY region_code`,
      [monitor.id],
    );

    expect(probes.rows.map((row) => row.region_code)).toEqual([
      "ap-south-1",
      "us-east-1",
    ]);
  });

  it("creates a monitor with India only when one region is selected", async () => {
    const fixture = await createWorkspaceFixture();

    const monitor = await monitorService.createMonitor(
      makeMonitorInput(fixture, {
        regionCodes: ["ap-south-1"],
      }),
    );

    const probes = await pool.query<{ region_code: string }>(
      `SELECT region_code
       FROM monitor_probes
       WHERE monitor_id = $1`,
      [monitor.id],
    );

    expect(probes.rows).toEqual([{ region_code: "ap-south-1" }]);
  });

  it("rejects a disabled region without creating a monitor", async () => {
    const fixture = await createWorkspaceFixture();

    await pool.query(
      `UPDATE monitor_regions
       SET is_enabled = FALSE
       WHERE code = 'us-east-1'`,
    );

    try {
      await expect(
        monitorService.createMonitor(makeMonitorInput(fixture)),
      ).rejects.toBeInstanceOf(InvalidMonitorRegionsError);

      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM monitors
         WHERE workspace_id = $1`,
        [fixture.workspaceId],
      );

      expect(Number(result.rows[0]?.count)).toBe(0);
    } finally {
      await pool.query(
        `UPDATE monitor_regions
         SET is_enabled = TRUE
         WHERE code = 'us-east-1'`,
      );
    }
  });

  it("rejects a user who is not a workspace member", async () => {
    const fixture = await createWorkspaceFixture();

    const input = makeMonitorInput({
      ...fixture,
      userId: `unauthorized-${randomUUID()}`,
    });

    await expect(monitorService.createMonitor(input)).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM monitors
       WHERE workspace_id = $1`,
      [fixture.workspaceId],
    );

    expect(Number(result.rows[0]?.count)).toBe(0);
  });

  it("rolls back the monitor when probe insertion fails", async () => {
    const fixture = await createWorkspaceFixture();

    // This constraint exists only temporarily in the isolated test database.
    // It forces the second region's probe insert to fail.
    await pool.query(`
      ALTER TABLE monitor_probes
      ADD CONSTRAINT integration_force_probe_failure
      CHECK (region_code <> 'us-east-1')
    `);

    try {
      await expect(
        monitorService.createMonitor(makeMonitorInput(fixture)),
      ).rejects.toThrow();

      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM monitors
         WHERE workspace_id = $1`,
        [fixture.workspaceId],
      );

      expect(Number(result.rows[0]?.count)).toBe(0);
    } finally {
      await pool.query(`
        ALTER TABLE monitor_probes
        DROP CONSTRAINT IF EXISTS integration_force_probe_failure
      `);
    }
  });
});
