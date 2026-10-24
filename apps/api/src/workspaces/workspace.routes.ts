import { Router, type Request } from "express";
import { z } from "zod";

import { logger } from "../lib/logger.js";
import type { CreateWorkspaceInput, Workspace } from "./workspace.service.js";

type WorkspaceRouteDependencies = {
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Workspace>;
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

  return router;
}
