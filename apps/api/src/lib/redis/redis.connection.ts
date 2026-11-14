import { Redis } from "ioredis";

import { logger } from "../logger.js";

export type CreateRedisConnectionOptions = {
  url: string;
  connectionName: string;
  connectTimeout: number;
  maxRetriesPerRequest: number | null;
};

export function createRedisConnection(
  options: CreateRedisConnectionOptions,
): Redis {
  const { url, connectionName, connectTimeout, maxRetriesPerRequest } = options;

  if (
    !url.trim() ||
    (!url.startsWith("redis://") && !url.startsWith("rediss://"))
  ) {
    throw new Error("A valid Redis connection URL is required");
  }

  if (!connectionName.trim()) {
    throw new Error("Redis connection name must not be empty");
  }

  if (!Number.isInteger(connectTimeout) || connectTimeout < 1) {
    throw new Error("Redis connection timeout must be a positive integer");
  }

  if (
    maxRetriesPerRequest !== null &&
    (!Number.isInteger(maxRetriesPerRequest) || maxRetriesPerRequest < 0)
  ) {
    throw new Error(
      "Redis maxRetriesPerRequest must be a non-negative integer or null",
    );
  }

  const connection = new Redis(url, {
    connectionName,
    connectTimeout,
    maxRetriesPerRequest,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  connection.on("error", (error) => {
    logger.error(
      {
        err: error,
        connectionName,
      },
      "Redis connection error",
    );
  });

  return connection;
}
