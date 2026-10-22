import { env } from "./config/env.js";
import { pool } from "./lib/db.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";

const port = env.PORT;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

const app = createApp({
  checkDatabase: async () => {
    await pool.query("SELECT 1");
  },
});

const server = app.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Nexus API is listening");
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Shutdown requested");

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error closing HTTP server");
      process.exitCode = 1;
    } else {
      logger.info("HTTP server closed");
    }

    void pool
      .end()
      .then(() => {
        logger.info("PostgreSQL connection pool closed");
      })
      .catch((poolError: unknown) => {
        logger.error(
          { err: poolError },
          "Error closing PostgreSQL connection pool",
        );

        process.exitCode = 1;
      });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
