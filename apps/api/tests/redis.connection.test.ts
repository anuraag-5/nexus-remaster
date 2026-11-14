import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{
    url: string;
    options: Record<string, unknown>;
    listeners: Map<string, (error: Error) => void>;
  }>,
  loggerError: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: class {
    url: string;
    options: Record<string, unknown>;
    listeners = new Map<string, (error: Error) => void>();

    constructor(url: string, options: Record<string, unknown>) {
      this.url = url;
      this.options = options;
      mocks.instances.push(this);
    }

    on(event: string, listener: (error: Error) => void) {
      this.listeners.set(event, listener);
      return this;
    }
  },
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
  },
}));

import { createRedisConnection } from "../src/lib/redis/redis.connection.js";

describe("createRedisConnection", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    mocks.loggerError.mockClear();
  });

  it("creates a lazy Redis connection with supplied configuration", () => {
    createRedisConnection({
      url: "redis://127.0.0.1:6379",
      connectionName: "nexus-publisher",
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
    });

    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]?.url).toBe("redis://127.0.0.1:6379");

    expect(mocks.instances[0]?.options).toEqual({
      connectionName: "nexus-publisher",
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  });

  it("supports the unlimited retry setting required by BullMQ workers", () => {
    createRedisConnection({
      url: "redis://127.0.0.1:6379",
      connectionName: "nexus-worker",
      connectTimeout: 5_000,
      maxRetriesPerRequest: null,
    });

    expect(mocks.instances[0]?.options).toMatchObject({
      maxRetriesPerRequest: null,
    });
  });

  it("creates independent connections on separate calls", () => {
    const first = createRedisConnection({
      url: "redis://127.0.0.1:6379",
      connectionName: "nexus-publisher",
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
    });

    const second = createRedisConnection({
      url: "redis://127.0.0.1:6379",
      connectionName: "nexus-worker",
      connectTimeout: 5_000,
      maxRetriesPerRequest: null,
    });

    expect(first).not.toBe(second);
    expect(mocks.instances).toHaveLength(2);
  });

  it.each([
    ["empty URL", { url: " " }],
    ["invalid URL scheme", { url: "http://localhost:6379" }],
    ["empty connection name", { connectionName: " " }],
    ["zero timeout", { connectTimeout: 0 }],
    ["negative timeout", { connectTimeout: -1 }],
    ["fractional timeout", { connectTimeout: 1.5 }],
    ["negative retry count", { maxRetriesPerRequest: -1 }],
    ["fractional retry count", { maxRetriesPerRequest: 1.5 }],
  ])("rejects %s", (_description, override) => {
    expect(() =>
      createRedisConnection({
        url: "redis://127.0.0.1:6379",
        connectionName: "nexus-test",
        connectTimeout: 5_000,
        maxRetriesPerRequest: 1,
        ...override,
      }),
    ).toThrow();
  });

  it("logs Redis connection errors with the connection name", () => {
    createRedisConnection({
      url: "redis://127.0.0.1:6379",
      connectionName: "nexus-publisher",
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
    });

    const listener = mocks.instances[0]?.listeners.get("error");
    expect(listener).toBeDefined();

    const error = new Error("Redis connection failed");
    listener?.(error);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        err: error,
        connectionName: "nexus-publisher",
      },
      "Redis connection error",
    );
  });
});
