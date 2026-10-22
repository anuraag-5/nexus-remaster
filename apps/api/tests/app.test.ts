import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

function createTestApp(checkDatabase: () => Promise<void> = async () => {}) {
  return createApp({ checkDatabase });
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
    const app = createTestApp(async () => {
      throw new Error("Database connection failed");
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

describe("Unknown routes", () => {
  it("returns 404 for a route that does not exist", async () => {
    const response = await request(createTestApp()).get(
      "/route-that-does-not-exist",
    );

    expect(response.status).toBe(404);
  });
});
