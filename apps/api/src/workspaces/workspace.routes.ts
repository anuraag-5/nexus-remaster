import { z } from "zod";
import { logger } from "../lib/logger.js";
import { Router, type Request } from "express";
import type {
  CreateWorkspaceInput,
  Workspace,
  WorkspaceSummary,
} from "./workspace.service.js";

type WorkspaceRouteDependencies = {
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;

  listWorkspaces: (userId: string) => Promise<WorkspaceSummary[]>;

  getAuthenticatedUserId: (req: Request) => string | null;
};

const createWorkspaceSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(100, "Workspace name must be at most 100 characters"),
});

export function createWorkspaceRouter({
  createWorkspace,
  listWorkspaces,
  getAuthenticatedUserId,
}: WorkspaceRouteDependencies) {
  const router = Router();

  router.post("/", async (req, res) => {
    // 1. Identify the authenticated user.
    const ownerUserId = getAuthenticatedUserId(req);

    if (!ownerUserId) {
      res.status(401).json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        },
      });
      return;
    }

    // 2. Validate the request body.
    const parsed = createWorkspaceSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Request body is invalid",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }

    // 3. Create the workspace and its owner membership.
    try {
      const workspace = await createWorkspace({
        name: parsed.data.name,
        ownerUserId,
      });

      res.status(201).json({
        data: workspace,
      });
    } catch (error) {
      logger.error({ err: error }, "Workspace creation failed");

      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to create workspace",
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

    try {
      const workspaces = await listWorkspaces(userId);
      res.status(200).json({
        data: workspaces,
      });
    } catch (error) {
      logger.error({ err: error }, "Workspace listing failed");
      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to list workspaces",
        },
      });
    }
  });

  return router;
}
