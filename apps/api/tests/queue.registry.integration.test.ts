import "dotenv/config";

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createQueueRegistry } from "../src/queue/queue.registry.js";
import type { MonitorCheckJob } from "../src/queue/queue.types.js";

describe("Queue registry Redis integration", () => {
  const redisConfig = {
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    REDIS_CONNECT_TIMEOUT_MS: Number(
      process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5_000,
    ),
  };

  const pool = {
    query: vi.fn().mockResolvedValue({
      rows: [{ code: "ap-south-1" }],
    }),
  } as unknown as Pool;

  const registry = createQueueRegistry({
    pool,
    redisConfig,
  });

  afterAll(async () => {
    await registry.close();
  });

  it("publishes and retrieves a real BullMQ job through Redis", async () => {
    const queue = await registry.getQueue("ap-south-1");

    const jobId = `integration-${randomUUID()}`;

    const payload: MonitorCheckJob = {
      executionId: randomUUID(),
      dispatchEventId: randomUUID(),
      regionCode: "ap-south-1",
    };

    try {
      const addedJob = await queue.add("monitor.check.requested", payload, {
        jobId,
      });

      expect(addedJob.id).toBe(jobId);

      const retrievedJob = await queue.getJob(jobId);

      expect(retrievedJob).toBeDefined();
      expect(retrievedJob?.name).toBe("monitor.check.requested");
      expect(retrievedJob?.data).toEqual(payload);
      expect(await retrievedJob?.getState()).toBe("waiting");
    } finally {
      // Remove only the job created by this test.
      const testJob = await queue.getJob(jobId);

      if (testJob) {
        await testJob.remove();
      }
    }
  });
});
