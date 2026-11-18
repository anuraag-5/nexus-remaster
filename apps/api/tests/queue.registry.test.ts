import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const redis = {
    status: "ready",
    quit: vi.fn(),
  };

  const queueInstances: Array<{
    name: string;
    options: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  return {
    redis,
    queueInstances,
    createRedisConnection: vi.fn(),
  };
});

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(name: string, options: Record<string, unknown>) {
      const instance = {
        name,
        options,
        close: vi.fn().mockResolvedValue(undefined),
      };

      mocks.queueInstances.push(instance);
      return instance;
    }
  },
}));

vi.mock("../src/lib/redis/redis.connection.js", () => ({
  createRedisConnection: mocks.createRedisConnection,
}));

import type { Pool } from "pg";

import {
  createQueueRegistry,
  RegionQueueUnavailableError,
} from "../src/queue/queue.registry.js";

const redisConfig = {
  REDIS_URL: "redis://127.0.0.1:6379",
  REDIS_CONNECT_TIMEOUT_MS: 5_000,
};

function createPool(
  queryImplementation = vi.fn().mockResolvedValue({
    rows: [{ code: "ap-south-1" }],
  }),
) {
  return {
    query: queryImplementation,
  } as unknown as Pool;
}

describe("createQueueRegistry", () => {
  beforeEach(() => {
    mocks.queueInstances.length = 0;

    mocks.redis.status = "ready";
    mocks.redis.quit.mockReset().mockImplementation(async () => {
      mocks.redis.status = "end";
      return "OK";
    });

    mocks.createRedisConnection.mockReset();
    mocks.createRedisConnection.mockReturnValue(mocks.redis);
  });

  it("creates a queue for an enabled region", async () => {
    const pool = createPool();
    const registry = createQueueRegistry({ pool, redisConfig });

    const queue = await registry.getQueue("ap-south-1");

    expect(mocks.queueInstances).toHaveLength(1);
    expect(mocks.queueInstances[0]?.name).toBe("nexus-checks-ap-south-1");
    expect(mocks.createRedisConnection).toHaveBeenCalledOnce();

    expect(mocks.createRedisConnection).toHaveBeenCalledWith({
      url: redisConfig.REDIS_URL,
      connectionName: "nexus-publisher-queues",
      connectTimeout: redisConfig.REDIS_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
    });

    expect(mocks.queueInstances[0]?.options.connection).toBe(mocks.redis);

    expect(queue).toBe(mocks.queueInstances[0]);

    await registry.close();
  });

  it("reuses the same queue instance for repeated requests", async () => {
    const registry = createQueueRegistry({
      pool: createPool(),
      redisConfig,
    });

    const first = await registry.getQueue("ap-south-1");
    const second = await registry.getQueue("ap-south-1");

    expect(first).toBe(second);
    expect(mocks.queueInstances).toHaveLength(1);
    expect(mocks.createRedisConnection).toHaveBeenCalledOnce();

    await registry.close();
  });

  it("rejects an unknown or disabled region", async () => {
    const pool = createPool(vi.fn().mockResolvedValue({ rows: [] }));

    const registry = createQueueRegistry({ pool, redisConfig });

    await expect(registry.getQueue("eu-west-1")).rejects.toBeInstanceOf(
      RegionQueueUnavailableError,
    );

    expect(mocks.queueInstances).toHaveLength(0);
    expect(mocks.createRedisConnection).not.toHaveBeenCalled();

    await registry.close();
  });

  it("closes and removes a cached queue when its region becomes disabled", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ code: "ap-south-1" }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [{ code: "ap-south-1" }],
      });

    const registry = createQueueRegistry({
      pool: createPool(query),
      redisConfig,
    });

    const first = await registry.getQueue("ap-south-1");
    const firstQueue = mocks.queueInstances[0];

    await expect(registry.getQueue("ap-south-1")).rejects.toBeInstanceOf(
      RegionQueueUnavailableError,
    );

    expect(firstQueue?.close).toHaveBeenCalledOnce();

    const second = await registry.getQueue("ap-south-1");

    expect(second).not.toBe(first);
    expect(mocks.queueInstances).toHaveLength(2);

    await registry.close();
  });

  it("normalizes region codes before querying and creating queues", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ code: "ap-south-1" }],
    });

    const registry = createQueueRegistry({
      pool: createPool(query),
      redisConfig,
    });

    await registry.getQueue(" AP-SOUTH-1 ");

    expect(query).toHaveBeenCalledWith(expect.any(String), ["ap-south-1"]);

    expect(mocks.queueInstances[0]?.name).toBe("nexus-checks-ap-south-1");

    await registry.close();
  });

  it("closes all queue instances before quitting the shared Redis connection", async () => {
    const query = vi.fn(async (_sql: string, values: unknown[]) => ({
      rows: [{ code: values[0] as string }],
    }));

    const registry = createQueueRegistry({
      pool: createPool(query),
      redisConfig,
    });

    await registry.getQueue("ap-south-1");
    await registry.getQueue("us-east-1");

    expect(mocks.queueInstances).toHaveLength(2);
    expect(mocks.createRedisConnection).toHaveBeenCalledOnce();

    const firstQueue = mocks.queueInstances[0];
    const secondQueue = mocks.queueInstances[1];

    await registry.close();

    expect(firstQueue?.close).toHaveBeenCalledOnce();
    expect(secondQueue?.close).toHaveBeenCalledOnce();
    expect(mocks.redis.quit).toHaveBeenCalledOnce();

    expect(firstQueue?.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redis.quit.mock.invocationCallOrder[0]!,
    );

    expect(secondQueue?.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redis.quit.mock.invocationCallOrder[0]!,
    );
  });

  it("closes queues before quitting Redis during registry shutdown", async () => {
    const registry = createQueueRegistry({
      pool: createPool(),
      redisConfig,
    });

    await registry.getQueue("ap-south-1");

    const queue = mocks.queueInstances[0];

    await registry.close();

    expect(queue?.close).toHaveBeenCalledOnce();
    expect(mocks.redis.quit).toHaveBeenCalledOnce();

    expect(queue?.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redis.quit.mock.invocationCallOrder[0]!,
    );
  });

  it("makes repeated shutdown calls idempotent", async () => {
    const registry = createQueueRegistry({
      pool: createPool(),
      redisConfig,
    });

    await registry.getQueue("ap-south-1");

    const firstClose = registry.close();
    const secondClose = registry.close();

    expect(secondClose).toBe(firstClose);

    await Promise.all([firstClose, secondClose]);

    expect(mocks.queueInstances[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.redis.quit).toHaveBeenCalledOnce();
  });

  it("rejects queue acquisition after shutdown", async () => {
    const registry = createQueueRegistry({
      pool: createPool(),
      redisConfig,
    });

    await registry.close();

    await expect(registry.getQueue("ap-south-1")).rejects.toThrow(
      "Queue registry is closed",
    );

    expect(mocks.queueInstances).toHaveLength(0);
  });

  it("still attempts Redis shutdown if a queue fails to close", async () => {
    const registry = createQueueRegistry({
      pool: createPool(),
      redisConfig,
    });

    await registry.getQueue("ap-south-1");

    const queue = mocks.queueInstances[0];
    queue?.close.mockRejectedValueOnce(new Error("Queue close failed"));

    await expect(registry.close()).rejects.toThrow(AggregateError);

    expect(mocks.redis.quit).toHaveBeenCalledOnce();
  });

  it("waits for every queue to finish closing before quitting Redis", async () => {
    const registry = createQueueRegistry({
      pool: createPool(),
      redisConfig,
    });

    await registry.getQueue("ap-south-1");
    await registry.getQueue("us-east-1");

    const firstQueue = mocks.queueInstances[0];
    const secondQueue = mocks.queueInstances[1];

    let resolveFirst!: () => void;
    let resolveSecond!: () => void;

    const firstClose = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const secondClose = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    firstQueue?.close.mockReturnValue(firstClose);
    secondQueue?.close.mockReturnValue(secondClose);

    const shutdown = registry.close();

    expect(mocks.redis.quit).not.toHaveBeenCalled();

    resolveFirst();
    await Promise.resolve();

    expect(mocks.redis.quit).not.toHaveBeenCalled();

    resolveSecond();
    await shutdown;

    expect(mocks.redis.quit).toHaveBeenCalledOnce();
  });

  it("does not create a queue if shutdown starts during region lookup", async () => {
    let resolveQuery!: (value: { rows: { code: string }[] }) => void;

    const queryPromise = new Promise<{
      rows: { code: string }[];
    }>((resolve) => {
      resolveQuery = resolve;
    });

    const query = vi.fn().mockReturnValue(queryPromise);

    const registry = createQueueRegistry({
      pool: createPool(query),
      redisConfig,
    });

    const acquisition = registry.getQueue("ap-south-1");

    const shutdown = registry.close();

    resolveQuery({
      rows: [{ code: "ap-south-1" }],
    });

    await expect(acquisition).rejects.toThrow("Queue registry is closed");

    await shutdown;

    expect(mocks.queueInstances).toHaveLength(0);
    expect(mocks.createRedisConnection).not.toHaveBeenCalled();
  });

  it("removes a disabled region queue even when closing it fails", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ code: "ap-south-1" }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [{ code: "ap-south-1" }],
      });

    const pool = createPool(query);

    const registry = createQueueRegistry({
      pool,
      redisConfig,
    });

    // First request: region is enabled, so a queue is created.
    const firstQueue = await registry.getQueue("ap-south-1");

    const firstQueueMock = mocks.queueInstances[0];

    // Simulate failure while closing the cached queue.
    firstQueueMock?.close.mockRejectedValueOnce(
      new Error("Queue close failed"),
    );

    // Second request: region is disabled.
    await expect(registry.getQueue("ap-south-1")).rejects.toThrow(
      "Queue close failed",
    );

    // Third request: region is enabled again.
    const newQueue = await registry.getQueue("ap-south-1");

    // The registry must create a new queue, not reuse the old one.
    expect(newQueue).not.toBe(firstQueue);
    expect(mocks.queueInstances).toHaveLength(2);

    await registry.close();
  });
});
