import type { Pool } from "pg";

import { logger } from "../lib/logger.js";

export type CreateWorkspaceInput = {
  name: string;
  ownerUserId: string;
};

export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  created_at: Date;
};

export function createWorkspaceService(pool: Pool) {
  return async function createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<Workspace> {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const result = await client.query<WorkspaceRow>(
        `INSERT INTO workspaces (name)
         VALUES ($1)
         RETURNING id, name, created_at`,
        [input.name],
      );

      const workspace = result.rows[0];

      if (!workspace) {
        throw new Error("Workspace creation returned no row");
      }

      await client.query(
        `INSERT INTO workspace_members (
           workspace_id,
           auth_provider_user_id,
           role
         )
         VALUES ($1, $2, 'owner')`,
        [workspace.id, input.ownerUserId],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.created_at.toISOString(),
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError },
            "Failed to roll back workspace creation",
          );
        }
      }

      throw error;
    } finally {
      client.release();
    }
  };
}
