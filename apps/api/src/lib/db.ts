import { Pool } from "pg";

import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => {
  logger.error(
    { err: error },
    "Unexpected error on an idle PostgreSQL client",
  );
});