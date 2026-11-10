import { z } from "zod";

const schedulerConfigSchema = z.object({
  SCHEDULER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(1_000),

  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
});

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

export function parseSchedulerConfig(
  input: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  return schedulerConfigSchema.parse(input);
}
