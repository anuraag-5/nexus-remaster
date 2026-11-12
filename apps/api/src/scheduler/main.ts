import { logger } from "../lib/logger.js";
import { databaseEnv } from "../config/database-env.js";
import { createDatabasePool } from "../lib/db/create-pool.js";
import { parseSchedulerConfig } from "./scheduler.config.js";
import { createSchedulerRunner } from "./scheduler.runner.js";
import { createSchedulerService } from "./scheduler.service.js";

const config = parseSchedulerConfig();

const pool = createDatabasePool({
  connectionString: databaseEnv.DATABASE_URL,
  max: config.SCHEDULER_DB_POOL_MAX,
  applicationName: "nexus-scheduler",
});

const schedulerService = createSchedulerService(pool);

const schedulerRunner = createSchedulerRunner({
  config,
  scheduleDueProbes: schedulerService.scheduleDueProbes,
  logger,
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  logger.info({ signal }, "Scheduler process shutdown requested");

  shutdownPromise = (async () => {
    let shutdownFailed = false;

    // Stop polling and wait for any active scheduling tick.
    try {
      await schedulerRunner.stop();
    } catch (error) {
      shutdownFailed = true;
      logger.error({ err: error }, "Failed to stop scheduler runner");
    }

    // Close the pool only after the runner has stopped.
    try {
      await pool.end();
      logger.info({}, "Scheduler database pool closed");
    } catch (error) {
      shutdownFailed = true;
      logger.error({ err: error }, "Failed to close scheduler database pool");
    }

    if (shutdownFailed) {
      process.exitCode = 1;
    }
  })();

  return shutdownPromise;
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

schedulerRunner.start();

logger.info(
  {
    pollIntervalMs: config.SCHEDULER_POLL_INTERVAL_MS,
    batchSize: config.SCHEDULER_BATCH_SIZE,
    databasePoolMax: config.SCHEDULER_DB_POOL_MAX,
  },
  "Scheduler process started",
);
