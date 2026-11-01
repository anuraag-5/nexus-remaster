import { Router, type Request } from "express";
import { z } from "zod";
import { parseMonitorUrlCandidate } from "./monitor-url-policy.js";

import { logger } from "../lib/logger.js";
import {
  WorkspaceAccessError,
  InvalidMonitorRegionsError,
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
    .transform((value, context) => {
      try {
        return parseMonitorUrlCandidate(value).toString();
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error ? error.message : "The URL is not allowed.",
        });

        return z.NEVER;
      }
    }),

  intervalSeconds: z.number().int().min(30).max(86400).default(300),

  timeoutMs: z.number().int().min(1000).max(60000).default(10000),

  regionCodes: z
    .array(z.string().trim().min(1).max(50))
    .min(1, "Select at least one monitoring region")
    .max(10, "Too many monitoring regions selected")
    .refine(
      (codes) => new Set(codes).size === codes.length,
      "Duplicate monitoring regions are not allowed",
    )
    .default(["ap-south-1", "us-east-1"]),
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

      if (error instanceof InvalidMonitorRegionsError) {
        res.status(400).json({
          error: {
            code: "INVALID_MONITOR_REGIONS",
            message:
              "One or more selected monitoring regions are invalid or disabled",
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
