import request from "supertest";
import { createApp } from "../src/app.js";
import { describe, expect, it } from "vitest";
import type { RequestHandler } from "express";

type TestAppOptions = {
  checkDatabase?: () => Promise<void>;
  userId?: string | null;
};

function createTestApp({
  checkDatabase = async () => {},
  userId = null,
}: TestAppOptions = {}) {
  const authMiddleware: RequestHandler = (_req, _res, next) => {
    next();
  };

  return createApp({
    checkDatabase,
    authMiddleware,
    getAuthenticatedUserId: () => userId,
    webOrigin: "http://localhost:3000",
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

describe("Unknown routes", () => {
  it("returns 404 for a route that does not exist", async () => {
    const response = await request(createTestApp()).get(
      "/route-that-does-not-exist",
    );

    expect(response.status).toBe(404);
  });
});
