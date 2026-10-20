
import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";

describe("GET /health/live", () => {
  it("returns a successful JSON health response", async () => {
    const response = await request(createApp())
      .get("/health/live");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"])
      .toMatch(/application\/json/);
    expect(response.body).toEqual({
      status: "ok",
    });
  });

  it("includes the expected security header", async () => {
    const response = await request(createApp())
      .get("/health/live");

    expect(response.headers["x-content-type-options"])
      .toBe("nosniff");
  });
});

describe("Unknown routes", () => {
  it("returns 404 for a route that does not exist", async () => {
    const response = await request(createApp())
      .get("/route-that-does-not-exist");

    expect(response.status).toBe(404);
  });
});