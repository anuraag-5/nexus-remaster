import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";

import { logger } from "./lib/logger.js";

type AppDependencies = {
  checkDatabase: () => Promise<void>;
};

export function createApp({ checkDatabase }: AppDependencies) {
  const app = express();

  app.disable("x-powered-by");

  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "1mb" }));

  // Liveness: is the API process responding?
  app.get("/health/live", (_req, res) => {
    res.status(200).json({
      status: "ok",
    });
  });

  // Readiness: can the API access its required database?
  app.get("/health/ready", async (_req, res) => {
    try {
      await checkDatabase();

      res.status(200).json({
        status: "ok",
        checks: {
          database: "ok",
        },
      });
    } catch (error) {
      logger.warn({ err: error }, "Database readiness check failed");

      res.status(503).json({
        status: "error",
        checks: {
          database: "error",
        },
      });
    }
  });

  return app;
}