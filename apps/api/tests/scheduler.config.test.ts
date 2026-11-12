import { describe, expect, it } from "vitest";

import { parseSchedulerConfig } from "../src/scheduler/scheduler.config.js";

describe("scheduler configuration", () => {
  it("uses default values when no scheduler variables are provided", () => {
    const config = parseSchedulerConfig({});

    expect(config).toEqual({
      SCHEDULER_POLL_INTERVAL_MS: 1_000,
      SCHEDULER_BATCH_SIZE: 100,
      SCHEDULER_DB_POOL_MAX: 3,
    });
  });

  it("accepts valid environment values", () => {
    const config = parseSchedulerConfig({
      SCHEDULER_POLL_INTERVAL_MS: "2000",
      SCHEDULER_BATCH_SIZE: "250",
      SCHEDULER_DB_POOL_MAX: "5",
    });

    expect(config).toEqual({
      SCHEDULER_POLL_INTERVAL_MS: 2_000,
      SCHEDULER_BATCH_SIZE: 250,
      SCHEDULER_DB_POOL_MAX: 5,
    });
  });

  it.each(["249", "60001", "1.5", "invalid"])(
    "rejects invalid polling intervals: %s",
    (value) => {
      expect(() =>
        parseSchedulerConfig({
          SCHEDULER_POLL_INTERVAL_MS: value,
        }),
      ).toThrow();
    },
  );

  it.each(["0", "501", "1.5", "invalid"])(
    "rejects invalid batch sizes: %s",
    (value) => {
      expect(() =>
        parseSchedulerConfig({
          SCHEDULER_BATCH_SIZE: value,
        }),
      ).toThrow();
    },
  );

  it.each(["0", "-1", "1.5", "invalid"])(
    "rejects invalid database pool sizes: %s",
    (value) => {
      expect(() =>
        parseSchedulerConfig({
          SCHEDULER_DB_POOL_MAX: value,
        }),
      ).toThrow();
    },
  );
});
