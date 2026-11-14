import { describe, expect, it } from "vitest";

import { parseRedisConfig } from "../src/lib/redis/redis.config.js";

describe("Redis configuration", () => {
  it("uses default values when optional variables are omitted", () => {
    const config = parseRedisConfig({
      REDIS_URL: "redis://127.0.0.1:6379",
    });

    expect(config).toEqual({
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_CONNECT_TIMEOUT_MS: 5_000,
    });
  });

  it("accepts valid Redis configuration", () => {
    const config = parseRedisConfig({
      REDIS_URL: "rediss://user:password@example.com:6380",
      REDIS_CONNECT_TIMEOUT_MS: "10000",
    });

    expect(config).toEqual({
      REDIS_URL: "rediss://user:password@example.com:6380",
      REDIS_CONNECT_TIMEOUT_MS: 10_000,
    });
  });

  it.each([
    "",
    "postgresql://localhost:5432/nexus",
    "http://localhost:6379",
    "not-a-url",
  ])("rejects invalid Redis URLs: %s", (url) => {
    expect(() =>
      parseRedisConfig({
        REDIS_URL: url,
      }),
    ).toThrow();
  });

  it.each(["0", "-1", "60001", "1.5", "invalid"])(
    "rejects invalid connection timeouts: %s",
    (timeout) => {
      expect(() =>
        parseRedisConfig({
          REDIS_URL: "redis://127.0.0.1:6379",
          REDIS_CONNECT_TIMEOUT_MS: timeout,
        }),
      ).toThrow();
    },
  );

  it("requires REDIS_URL", () => {
    expect(() => parseRedisConfig({})).toThrow();
  });
});
