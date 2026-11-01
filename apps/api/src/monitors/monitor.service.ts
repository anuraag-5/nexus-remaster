import type { Pool, PoolClient } from "pg";

import { logger } from "../lib/logger.js";

export type MonitorStatus = "unknown" | "up" | "down";

export type Monitor = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  isEnabled: boolean;
  currentStatus: MonitorStatus;
  nextCheckAt: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateMonitorInput = {
  workspaceId: string;
  userId: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  regionCodes: string[];
};

export type ListMonitorsInput = {
  workspaceId: string;
  userId: string;
};

type MonitorRow = {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  interval_seconds: number;
  timeout_ms: number;
  is_enabled: boolean;
  current_status: MonitorStatus;
  next_check_at: Date;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export class WorkspaceAccessError extends Error {
  constructor() {
    super("Workspace not found or access denied");
    this.name = "WorkspaceAccessError";
  }
}

export class InvalidMonitorRegionsError extends Error {
  constructor() {
    super("One or more monitoring regions are invalid or disabled");
    this.name = "InvalidMonitorRegionsError";
  }
}

function toMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    url: row.url,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    isEnabled: row.is_enabled,
    currentStatus: row.current_status,
    nextCheckAt: row.next_check_at.toISOString(),
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function verifyWorkspaceMembership(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1
       AND auth_provider_user_id = $2
     FOR KEY SHARE`,
    [workspaceId, userId],
  );

  if (result.rows.length === 0) {
    throw new WorkspaceAccessError();
  }
}

async function verifyMonitorRegions(
  client: PoolClient,
  regionCodes: string[],
): Promise<void> {
  if (
    regionCodes.length === 0 ||
    new Set(regionCodes).size !== regionCodes.length
  ) {
    throw new InvalidMonitorRegionsError();
  }

  const result = await client.query<{ code: string }>(
    `SELECT code
     FROM monitor_regions
     WHERE code = ANY($1::text[])
       AND is_enabled = TRUE`,
    [regionCodes],
  );

  if (result.rows.length !== regionCodes.length) {
    throw new InvalidMonitorRegionsError();
  }
}

export function createMonitorService(pool: Pool) {
  async function createMonitor(input: CreateMonitorInput): Promise<Monitor> {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      await verifyWorkspaceMembership(client, input.workspaceId, input.userId);
      await verifyMonitorRegions(client, input.regionCodes);

      const result = await client.query<MonitorRow>(
        `INSERT INTO monitors (
           workspace_id,
           name,
           url,
           interval_seconds,
           timeout_ms
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING
           id,
           workspace_id,
           name,
           url,
           interval_seconds,
           timeout_ms,
           is_enabled,
           current_status,
           next_check_at,
           last_checked_at,
           created_at,
           updated_at`,
        [
          input.workspaceId,
          input.name,
          input.url,
          input.intervalSeconds,
          input.timeoutMs,
        ],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error("Monitor creation returned no row");
      }

      await client.query(
        `INSERT INTO monitor_probes (
     monitor_id,
     region_code
   )
   SELECT
     $1,
     selected.region_code
   FROM UNNEST($2::text[]) AS selected(region_code)`, //UNNEST splits array into individual rows.
        [row.id, input.regionCodes],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return toMonitor(row);
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError },
            "Failed to roll back monitor creation",
          );
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async function listMonitors(input: ListMonitorsInput): Promise<Monitor[]> {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      await verifyWorkspaceMembership(client, input.workspaceId, input.userId);

      const result = await client.query<MonitorRow>(
        `SELECT
           id,
           workspace_id,
           name,
           url,
           interval_seconds,
           timeout_ms,
           is_enabled,
           current_status,
           next_check_at,
           last_checked_at,
           created_at,
           updated_at
         FROM monitors
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [input.workspaceId],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return result.rows.map(toMonitor);
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError },
            "Failed to roll back monitor listing",
          );
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  return {
    createMonitor,
    listMonitors,
  };
}
