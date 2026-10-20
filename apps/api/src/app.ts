
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";

import { logger } from "./lib/logger.js";

export function createApp() {
  const app = express();

  // Disable Express's X-Powered-By header.
  app.disable("x-powered-by");

  // Apply security-related HTTP headers.
  app.use(helmet());

  // Log incoming HTTP requests.
  app.use(pinoHttp({ logger }));

  // Parse JSON request bodies, with a size limit.
  app.use(express.json({ limit: "1mb" }));

  // Liveness endpoint: is this process responding?
  app.get("/health/live", (_req, res) => {
    res.status(200).json({
      status: "ok",
    });
  });

  return app;
}