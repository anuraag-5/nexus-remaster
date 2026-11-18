import { Queue } from "bullmq";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

import { createRedisConnection } from "../lib/redis/redis.connection.js";
import type { RedisConfig } from "../lib/redis/redis.config.js";
import { getQueueName } from "./queue.constants.js";
import type { MonitorCheckJob } from "./queue.types.js";

export class RegionQueueUnavailableError extends Error {
  constructor(regionCode: string) {
    super(`Region is unknown or disabled: ${regionCode}`);
    this.name = "RegionQueueUnavailableError";
  }
}

export type QueueRegistryOptions = {
  pool: Pool;
  redisConfig: RedisConfig;
};

export function createQueueRegistry({
  pool,
  redisConfig,
}: QueueRegistryOptions) {
  const queues = new Map<string, Queue<MonitorCheckJob>>();
  let redis: Redis | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function getRedisConnection(): Redis {
    if (!redis) {
      redis = createRedisConnection({
        url: redisConfig.REDIS_URL,
        connectionName: "nexus-publisher-queues",
        connectTimeout: redisConfig.REDIS_CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
      });
    }

    return redis;
  }

  async function getQueue(regionCode: string): Promise<Queue<MonitorCheckJob>> {
    if (closed) {
      throw new Error("Queue registry is closed");
    }

    const normalizedRegionCode = regionCode.trim().toLowerCase();

    // Validate the code before querying the database.
    const queueName = getQueueName(normalizedRegionCode);

    const result = await pool.query<{ code: string }>(
      `SELECT code
       FROM monitor_regions
       WHERE code = $1
         AND is_enabled = TRUE`,
      [normalizedRegionCode],
    );

    // Shutdown may have started while the database query was pending.
    if (closed) {
      throw new Error("Queue registry is closed");
    }

    const enabledRegion = result.rows[0];

    if (!enabledRegion) {
      const existingQueue = queues.get(normalizedRegionCode);

      if (existingQueue) {
        queues.delete(normalizedRegionCode);
        await existingQueue.close();
      }

      throw new RegionQueueUnavailableError(normalizedRegionCode);
    }

    const existingQueue = queues.get(normalizedRegionCode);

    if (existingQueue) {
      return existingQueue;
    }

    const queue = new Queue<MonitorCheckJob>(queueName, {
      connection: getRedisConnection(),
    });

    queues.set(normalizedRegionCode, queue);

    return queue;
  }

  function close(): Promise<void> {
    if (closePromise) {
      return closePromise;
    }

    closed = true;

    closePromise = (async () => {
      const queueInstances = [...queues.values()];
      queues.clear();

      const results = await Promise.allSettled(
        queueInstances.map((queue) => queue.close()),
      );

      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);

      if (redis && redis.status !== "end") {
        try {
          await redis.quit();
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Failed to close all queue registry resources",
        );
      }
    })();

    return closePromise;
  }

  return {
    getQueue,
    close,
  };
}
