import type {
  CreateWorkspaceInput,
  Workspace,
} from "../src/workspaces/workspace.service.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { describe, expect, it } from "vitest";
import type { RequestHandler } from "express";

type TestAppOptions = {
  checkDatabase?: () => Promise<void>;
  userId?: string | null;
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<Workspace>;
};

function createTestApp({
  checkDatabase = async () => {},
  userId = null,
  createWorkspace,
}: TestAppOptions = {}) {
  const authMiddleware: RequestHandler = (_req, _res, next) => {
    next();
  };

  const defaultCreateWorkspace = async ({
    name,
  }: CreateWorkspaceInput): Promise<Workspace> => ({
    id: "workspace_test_123",
    name,
    createdAt: "2026-10-24T10:00:00.000Z",
  });

  return createApp({
    checkDatabase,
    authMiddleware,
    getAuthenticatedUserId: () => userId,
    webOrigin: "http://localhost:3000",
    createWorkspace: createWorkspace ?? defaultCreateWorkspace,
  });
}

describe("GET /health/live", () => {
  it("returns a successful JSON health response", async () => {
    const response = await request(createTestApp()).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({
      status: "ok",
    });
  });

  it("includes the expected security header", async () => {
    const response = await request(createTestApp()).get("/health/live");

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("GET /health/ready", () => {
  it("returns 200 when the database route check succeeds.", async () => {
    const app = createTestApp();

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      checks: {
        database: "ok",
      },
    });
  });

  it("returns 503 when the database route check fails.", async () => {
    const app = createTestApp({
      checkDatabase: async () => {
        throw new Error("Database connection failed");
      },
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "error",
      checks: {
        database: "error",
      },
    });
  });
});

describe("GET /api/v1/me", () => {
  it("returns 401 when the user is not authenticated", async () => {
    const app = createTestApp();

    const response = await request(app).get("/api/v1/me");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      },
    });
  });

  it("returns the user ID when authenticated", async () => {
    const app = createTestApp({
      userId: "user_test_123",
    });

    const response = await request(app).get("/api/v1/me");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: "user_test_123",
    });
  });
});

describe("POST /api/v1/workspaces", () => {
  it("requires an authenticated user", async () => {
    const app = createTestApp();

    const response = await request(app)
      .post("/api/v1/workspaces")
      .send({ name: "My Workspace" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("creates a workspace for the authenticated user", async () => {
    let receivedInput: CreateWorkspaceInput | undefined;

    const app = createTestApp({
      userId: "user_test_123",
      createWorkspace: async (input) => {
        receivedInput = input;

        return {
          id: "workspace_test_123",
          name: input.name,
          createdAt: "2026-10-24T10:00:00.000Z",
        };
      },
    });

    const response = await request(app)
      .post("/api/v1/workspaces")
      .send({ name: "  My Workspace  " });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({
      id: "workspace_test_123",
      name: "My Workspace",
      createdAt: "2026-10-24T10:00:00.000Z",
    });

    expect(receivedInput).toEqual({
      name: "My Workspace",
      ownerUserId: "user_test_123",
    });
  });

  it("rejects invalid workspace names", async () => {
    let serviceCalled = false;

    const app = createTestApp({
      userId: "user_test_123",
      createWorkspace: async ({ name }) => {
        serviceCalled = true;

        return {
          id: "workspace_test_123",
          name,
          createdAt: "2026-10-24T10:00:00.000Z",
        };
      },
    });

    const response = await request(app)
      .post("/api/v1/workspaces")
      .send({ name: "   " });

    expect(response.status).toBe(400);
    expect(serviceCalled).toBe(false);
  });

  it("does not accept an owner ID supplied by the client", async () => {
    let serviceCalled = false;

    const app = createTestApp({
      userId: "user_test_123",
      createWorkspace: async ({ name }) => {
        serviceCalled = true;

        return {
          id: "workspace_test_123",
          name,
          createdAt: "2026-10-24T10:00:00.000Z",
        };
      },
    });

    const response = await request(app).post("/api/v1/workspaces").send({
      name: "My Workspace",
      ownerUserId: "user_attacker",
    });

    expect(response.status).toBe(400);
    expect(serviceCalled).toBe(false);
  });
});

describe("Unknown routes", () => {
  it("returns 404 for a route that does not exist", async () => {
    const response = await request(createTestApp()).get(
      "/route-that-does-not-exist",
    );

    expect(response.status).toBe(404);
  });
});
