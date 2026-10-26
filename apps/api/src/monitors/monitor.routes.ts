import { Router, type Request } from "express";
import { z } from "zod";

import { logger } from "../lib/logger.js";
import {
  WorkspaceAccessError,
  type CreateMonitorInput,
  type ListMonitorsInput,
  type Monitor,
} from "./monitor.service.js";

type MonitorRouteDependencies = {
  createMonitor: (input: CreateMonitorInput) => Promise<Monitor>;
  listMonitors: (input: ListMonitorsInput) => Promise<Monitor[]>;
  getAuthenticatedUserId: (req: Request) => string | null;
};

const workspaceParamsSchema = z.object({
  workspaceId: z.uuid(),
});

const createMonitorSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Monitor name is required")
    .max(100, "Monitor name must be at most 100 characters"),

  url: z
    .string()
    .trim()
    .pipe(z.url())
    .refine((value) => {
      const parsedUrl = new URL(value);

      return (
        (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
        parsedUrl.username === "" &&
        parsedUrl.password === ""
      );
    }, "URL must use HTTP or HTTPS and must not contain credentials"),

  intervalSeconds: z.number().int().min(30).max(86400).default(300),

  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
});

export function createMonitorRouter({
  createMonitor,
  listMonitors,
  getAuthenticatedUserId,
}: MonitorRouteDependencies) {
  const router = Router({ mergeParams: true });

  router.post("/", async (req, res) => {
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

    const parsedParams = workspaceParamsSchema.safeParse(req.params);

    if (!parsedParams.success) {
      res.status(400).json({
        error: {
          code: "INVALID_WORKSPACE_ID",
          message: "Workspace ID must be a valid UUID",
        },
      });
      return;
    }

    const parsedBody = createMonitorSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Request body is invalid",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }

    try {
      const monitor = await createMonitor({
        workspaceId: parsedParams.data.workspaceId,
        userId,
        ...parsedBody.data,
      });

      res.status(201).json({ data: monitor });
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        res.status(404).json({
          error: {
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found",
          },
        });
        return;
      }

      logger.error({ err: error }, "Monitor creation failed");

      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to create monitor",
        },
      });
    }
  });

  router.get("/", async (req, res) => {
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

    const parsedParams = workspaceParamsSchema.safeParse(req.params);

    if (!parsedParams.success) {
      res.status(400).json({
        error: {
          code: "INVALID_WORKSPACE_ID",
          message: "Workspace ID must be a valid UUID",
        },
      });
      return;
    }

    try {
      const monitors = await listMonitors({
        workspaceId: parsedParams.data.workspaceId,
        userId,
      });

      res.status(200).json({ data: monitors });
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        res.status(404).json({
          error: {
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found",
          },
        });
        return;
      }

      logger.error({ err: error }, "Monitor listing failed");

      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to list monitors",
        },
      });
    }
  });

  return router;
}