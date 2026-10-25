import cors from "cors";
import helmet from "helmet";
import express from "express";
import { pinoHttp } from "pino-http";
import type { Request, RequestHandler } from "express";
import { createWorkspaceRouter } from "./workspaces/workspace.routes.js";

import type {
  CreateWorkspaceInput,
  Workspace,
  WorkspaceSummary,
} from "./workspaces/workspace.service.js";
import { logger } from "./lib/logger.js";

type AppDependencies = {
  checkDatabase: () => Promise<void>;
  authMiddleware: RequestHandler;
  getAuthenticatedUserId: (req: Request) => string | null;
  webOrigin: string;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
  listWorkspaces: (userId: string) => Promise<WorkspaceSummary[]>;
};

export function createApp({
  checkDatabase,
  authMiddleware,
  getAuthenticatedUserId,
  webOrigin,
  createWorkspace,
  listWorkspaces
}: AppDependencies) {
  const app = express();

  app.use(authMiddleware);

  app.use(
    cors({
      origin: webOrigin,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "1mb" }));
  
  app.use(
    "/api/v1/workspaces",
    createWorkspaceRouter({
      createWorkspace,
      getAuthenticatedUserId,
      listWorkspaces
    }),
  );

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

  app.get("/api/v1/me", (req, res) => {
    const userId = getAuthenticatedUserId(req);

    if (!userId) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        },
      });
      return;
    }

    res.status(200).json({ userId });
  });

  return app;
}
