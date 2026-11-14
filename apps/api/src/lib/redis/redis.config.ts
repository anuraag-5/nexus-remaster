import { z } from "zod";

const redisConfigSchema = z.object({
  REDIS_URL: z
    .url()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "REDIS_URL must be a Redis connection URL",
    ),

  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60_000)
    .default(5_000),
});

export type RedisConfig = z.infer<typeof redisConfigSchema>;

export function parseRedisConfig(
  input: NodeJS.ProcessEnv = process.env,
): RedisConfig {
  return redisConfigSchema.parse(input);
}
