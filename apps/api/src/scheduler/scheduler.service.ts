import type { Pool, PoolClient } from "pg";

import { logger } from "../lib/logger.js";
import type {
  ScheduleDueProbesInput,
  ScheduleDueProbesResult,
} from "./scheduler.types.js";

const MAX_BATCH_SIZE = 500;
const OUTBOX_EVENT_TYPE = "monitor.check.requested";

type DueProbeRow = {
  probe_id: string;
  interval_seconds: number;
  scheduled_for: Date;
  next_check_at: Date;
};

export class InvalidSchedulerBatchSizeError extends Error {
  constructor() {
    super(
      `Scheduler batch size must be an integer between 1 and ${MAX_BATCH_SIZE}`,
    );
    this.name = "InvalidSchedulerBatchSizeError";
  }
}

async function selectDueProbes(
  client: PoolClient,
  batchSize: number,
): Promise<DueProbeRow[]> {
  const result = await client.query<DueProbeRow>(
    `SELECT
       p.id AS probe_id,
       m.interval_seconds,
       p.next_check_at
         + FLOOR(
             EXTRACT(
               EPOCH FROM (transaction_timestamp() - p.next_check_at)
             ) / m.interval_seconds
           ) * m.interval_seconds * INTERVAL '1 second'
         AS scheduled_for,
       p.next_check_at
         + (
             FLOOR(
               EXTRACT(
                 EPOCH FROM (transaction_timestamp() - p.next_check_at)
               ) / m.interval_seconds
             ) + 1
           ) * m.interval_seconds * INTERVAL '1 second'
         AS next_check_at
     FROM monitor_probes AS p
     INNER JOIN monitors AS m
       ON m.id = p.monitor_id
     INNER JOIN monitor_regions AS r
       ON r.code = p.region_code
     WHERE p.is_enabled = TRUE
       AND m.is_enabled = TRUE
       AND r.is_enabled = TRUE
       AND p.next_check_at <= transaction_timestamp()
     ORDER BY p.next_check_at ASC, p.id ASC
     LIMIT $1
     FOR UPDATE OF p SKIP LOCKED`,
    [batchSize],
  );

  return result.rows;
}

async function createExecutionAndOutbox(
  client: PoolClient,
  probe: DueProbeRow,
): Promise<void> {
  const executionResult = await client.query<{ id: string }>(
    `INSERT INTO monitor_executions (
       probe_id,
       scheduled_for
     )
     VALUES ($1, $2)
     RETURNING id`,
    [probe.probe_id, probe.scheduled_for],
  );

  const executionId = executionResult.rows[0]?.id;

  if (!executionId) {
    throw new Error("Scheduler failed to create a logical execution");
  }

  await client.query(
    `INSERT INTO outbox_events (
       execution_id,
       event_type
     )
     VALUES ($1, $2)`,
    [executionId, OUTBOX_EVENT_TYPE],
  );

  const updateResult = await client.query(
    `UPDATE monitor_probes
     SET
       next_check_at = $2,
       updated_at = transaction_timestamp()
     WHERE id = $1`,
    [probe.probe_id, probe.next_check_at],
  );

  if (updateResult.rowCount !== 1) {
    throw new Error(
      `Scheduler failed to advance probe schedule: ${probe.probe_id}`,
    );
  }
}

export function createSchedulerService(pool: Pool) {
  async function scheduleDueProbes(
    input: ScheduleDueProbesInput,
  ): Promise<ScheduleDueProbesResult> {
    if (
      !Number.isInteger(input.batchSize) ||
      input.batchSize < 1 ||
      input.batchSize > MAX_BATCH_SIZE
    ) {
      throw new InvalidSchedulerBatchSizeError();
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const dueProbes = await selectDueProbes(client, input.batchSize);

      for (const probe of dueProbes) {
        await createExecutionAndOutbox(client, probe);
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return {
        scheduledCount: dueProbes.length,
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError },
            "Failed to roll back scheduler transaction",
          );
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  return {
    scheduleDueProbes,
  };
}
