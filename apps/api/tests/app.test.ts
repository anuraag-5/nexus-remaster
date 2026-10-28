import type {
  CreateWorkspaceInput,
  Workspace,
  WorkspaceSummary,
} from "../src/workspaces/workspace.service.js";
import request from "supertest";
import { createApp } from "../src/app.js";
import { describe, expect, it } from "vitest";
import type { RequestHandler } from "express";
import { WorkspaceAccessError } from "../src/monitors/monitor.service.js";
import { CreateMonitorInput, ListMonitorsInput, Monitor } from "../src/monitors/monitor.service.js";

type TestAppOptions = {
  checkDatabase?: () => Promise<void>;
  userId?: string | null;
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<Workspace>;
  listWorkspaces? : (userId: string) => Promise<WorkspaceSummary[]>;
  createMonitor? : (input: CreateMonitorInput) => Promise<Monitor>;
  listMonitors? : (input: ListMonitorsInput) => Promise<Monitor[]>;
};

const makeTestMonitor = (
  input: CreateMonitorInput,
): Monitor => ({
  id: "monitor_test_123",
  workspaceId: input.workspaceId,
  name: input.name,
  url: input.url,
  intervalSeconds: input.intervalSeconds,
  timeoutMs: input.timeoutMs,
  isEnabled: true,
  currentStatus: "unknown",
  nextCheckAt: "2026-10-26T00:00:00.000Z",
  lastCheckedAt: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
});

function createTestApp({
  checkDatabase = async () => {},
  userId = null,
  createWorkspace,
  listWorkspaces,
  createMonitor,
  listMonitors
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
    listWorkspaces: listWorkspaces ?? (async () => []),
    createMonitor: createMonitor ?? (async (input) => makeTestMonitor(input)),
    listMonitors: listMonitors ?? (async () => []),
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

describe("GET /api/v1/workspaces", () => {
  it("requires an authenticated user", async () => {
    const app = createTestApp();

    const response = await request(app)
      .get("/api/v1/workspaces");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("lists workspaces for the authenticated user", async () => {
    let receivedUserId: string | undefined;

    const app = createTestApp({
      userId: "user_test_123",

      listWorkspaces: async (userId) => {
        receivedUserId = userId;

        return [
          {
            id: "workspace_test_123",
            name: "Stacklify",
            role: "owner",
            createdAt: "2026-10-24T11:22:48.163Z",
          },
        ];
      },
    });

    const response = await request(app)
      .get("/api/v1/workspaces");

    expect(response.status).toBe(200);
    expect(receivedUserId).toBe("user_test_123");

    expect(response.body.data).toEqual([
      {
        id: "workspace_test_123",
        name: "Stacklify",
        role: "owner",
        createdAt: "2026-10-24T11:22:48.163Z",
      },
    ]);
  });

  it("returns an empty array when the user has no workspaces", async () => {
    const app = createTestApp({
      userId: "user_without_workspaces",
    });

    const response = await request(app)
      .get("/api/v1/workspaces");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});


const workspaceId = "b16c2fa2-ee2b-4f0e-a545-1ccd8e46f85c";

describe("POST /api/v1/workspaces/:workspaceId/monitors", () => {
  it("requires an authenticated user", async () => {
    let serviceCalled = false;

    const app = createTestApp({
      createMonitor: async (input) => {
        serviceCalled = true;
        return makeTestMonitor(input);
      },
    });

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/monitors`)
      .send({
        name: "Homepage",
        url: "https://example.com",
      });

    expect(response.status).toBe(401);
    expect(serviceCalled).toBe(false);
  });

  it("creates a monitor using the authenticated user's identity", async () => {
    let receivedInput: CreateMonitorInput | undefined;

    const app = createTestApp({
      userId: "user_test_123",
      createMonitor: async (input) => {
        receivedInput = input;
        return makeTestMonitor(input);
      },
    });

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/monitors`)
      .send({
        name: "  Homepage  ",
        url: "https://example.com/health",
      });

    expect(response.status).toBe(201);

    expect(receivedInput).toEqual({
      workspaceId,
      userId: "user_test_123",
      name: "Homepage",
      url: "https://example.com/health",
      intervalSeconds: 300,
      timeoutMs: 10000,
    });

    expect(response.body.data).toMatchObject({
      workspaceId,
      name: "Homepage",
      url: "https://example.com/health",
      intervalSeconds: 300,
      timeoutMs: 10000,
      currentStatus: "unknown",
    });
  });

  it("rejects non-HTTP URLs", async () => {
    let serviceCalled = false;

    const app = createTestApp({
      userId: "user_test_123",
      createMonitor: async (input) => {
        serviceCalled = true;
        return makeTestMonitor(input);
      },
    });

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/monitors`)
      .send({
        name: "Invalid target",
        url: "ftp://example.com",
      });

    expect(response.status).toBe(400);
    expect(serviceCalled).toBe(false);
  });

  it("rejects an owner ID supplied by the client", async () => {
    let serviceCalled = false;

    const app = createTestApp({
      userId: "user_test_123",
      createMonitor: async (input) => {
        serviceCalled = true;
        return makeTestMonitor(input);
      },
    });

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/monitors`)
      .send({
        name: "Homepage",
        url: "https://example.com",
        ownerUserId: "user_attacker",
      });

    expect(response.status).toBe(400);
    expect(serviceCalled).toBe(false);
  });

  it("returns 404 when the user cannot access the workspace", async () => {
    const app = createTestApp({
      userId: "user_test_123",
      createMonitor: async () => {
        throw new WorkspaceAccessError();
      },
    });

    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/monitors`)
      .send({
        name: "Homepage",
        url: "https://example.com",
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("GET /api/v1/workspaces/:workspaceId/monitors", () => {
  it("requires an authenticated user", async () => {
    const app = createTestApp();

    const response = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/monitors`);

    expect(response.status).toBe(401);
  });

  it("lists monitors for the authenticated user's workspace", async () => {
    let receivedInput: ListMonitorsInput | undefined;

    const app = createTestApp({
      userId: "user_test_123",
      listMonitors: async (input) => {
        receivedInput = input;

        return [
          {
            id: "monitor_test_123",
            workspaceId,
            name: "Homepage",
            url: "https://example.com",
            intervalSeconds: 300,
            timeoutMs: 10000,
            isEnabled: true,
            currentStatus: "unknown",
            nextCheckAt: "2026-10-26T00:00:00.000Z",
            lastCheckedAt: null,
            createdAt: "2026-10-26T00:00:00.000Z",
            updatedAt: "2026-10-26T00:00:00.000Z",
          },
        ];
      },
    });

    const response = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/monitors`);

    expect(response.status).toBe(200);

    expect(receivedInput).toEqual({
      workspaceId,
      userId: "user_test_123",
    });

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      id: "monitor_test_123",
      workspaceId,
      name: "Homepage",
      currentStatus: "unknown",
    });
  });

  it("returns 404 when the user cannot access the workspace", async () => {
    const app = createTestApp({
      userId: "user_test_123",
      listMonitors: async () => {
        throw new WorkspaceAccessError();
      },
    });

    const response = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/monitors`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("WORKSPACE_NOT_FOUND");
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
