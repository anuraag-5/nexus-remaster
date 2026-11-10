import "dotenv/config";
import { z } from "zod";

const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine(
      (value) =>
        value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection URL",
    ),
});

const result = databaseEnvSchema.safeParse(process.env);

if (!result.success) {
  const errors = result.error.issues
    .map(
      (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
    )
    .join("\n");

  throw new Error(`Invalid database environment configuration:\n${errors}`);
}

export const databaseEnv = result.data;
