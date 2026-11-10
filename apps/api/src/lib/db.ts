import { Pool } from "pg";

import { databaseEnv } from "../config/database-env.js";
import { logger } from "./logger.js";

export const pool = new Pool({
  connectionString: databaseEnv.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => {
  logger.error({ err: error }, "Unexpected error on an idle PostgreSQL client");
});
