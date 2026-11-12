import { Pool } from "pg";
import { logger } from "../logger.js";

export type CreateDatabasePoolOptions = {
  connectionString: string;
  max: number;
  applicationName: string;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
};

export function createDatabasePool(options: CreateDatabasePoolOptions): Pool {
  const {
    connectionString,
    max,
    applicationName,
    idleTimeoutMillis = 30_000,
    connectionTimeoutMillis = 5_000,
  } = options;

  if (!connectionString.trim()) {
    throw new Error("Database connection string must not be empty");
  }

  if (!Number.isInteger(max) || max < 1) {
    throw new Error("Database pool max must be a positive integer");
  }

  if (!applicationName.trim()) {
    throw new Error("Database application name must not be empty");
  }

  if (!Number.isInteger(idleTimeoutMillis) || idleTimeoutMillis < 0) {
    throw new Error("Database idle timeout must be a non-negative integer");
  }

  if (
    !Number.isInteger(connectionTimeoutMillis) ||
    connectionTimeoutMillis < 1
  ) {
    throw new Error("Database connection timeout must be a positive integer");
  }

  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    application_name: applicationName,
  });

  pool.on("error", (error) => {
    logger.error(
      { err: error, applicationName },
      "Unexpected error on an idle PostgreSQL client",
    );
  });

  return pool;
}
