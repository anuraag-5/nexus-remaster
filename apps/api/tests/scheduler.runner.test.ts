import { describe, expect, it, vi } from "vitest";

import { createSchedulerRunner } from "../src/scheduler/scheduler.runner.js";

describe("scheduler runner", () => {
  const config = {
    SCHEDULER_POLL_INTERVAL_MS: 1_000,
    SCHEDULER_BATCH_SIZE: 100,
    SCHEDULER_DB_POOL_MAX: 3
  };

  function createDependencies() {
    return {
      config,
      scheduleDueProbes: vi.fn().mockResolvedValue({
        scheduledCount: 2,
      }),
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      wait: vi.fn(
        (_milliseconds: number, signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }

            signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          }),
      ),
    };
  }

  it("runs a scheduling tick with the configured batch size", async () => {
    const dependencies = createDependencies();
    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledWith({
        batchSize: 100,
      });
    });

    await runner.stop();

    expect(dependencies.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledCount: 2 }),
      "Scheduler tick completed",
    );
  });

  it("does not start overlapping ticks", async () => {
    const dependencies = createDependencies();

    let resolveTick!: (value: { scheduledCount: number }) => void;

    dependencies.scheduleDueProbes.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTick = resolve;
        }),
    );

    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
    });

    await Promise.resolve();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);

    resolveTick({ scheduledCount: 1 });

    await vi.waitFor(() => {
      expect(dependencies.wait).toHaveBeenCalledTimes(1);
    });

    await runner.stop();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
  });

  it("continues polling after a scheduling failure", async () => {
    const dependencies = createDependencies();

    dependencies.scheduleDueProbes
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValueOnce({ scheduledCount: 1 });

    dependencies.wait.mockResolvedValueOnce(undefined).mockImplementation(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }

          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    );

    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(2);
    });

    await runner.stop();

    expect(dependencies.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
      }),
      "Scheduler tick failed",
    );

    expect(dependencies.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledCount: 1,
      }),
      "Scheduler tick completed",
    );
  });

  it("stops without starting another tick", async () => {
    const dependencies = createDependencies();
    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.wait).toHaveBeenCalledTimes(1);
    });

    await runner.stop();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
  });

  it("does not start another loop when start is called twice", async () => {
    const dependencies = createDependencies();
    const runner = createSchedulerRunner(dependencies);

    runner.start();
    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
    });

    await runner.stop();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
  });

  it("stops the loop after an unexpected polling wait failure", async () => {
    const dependencies = createDependencies();

    dependencies.wait.mockRejectedValueOnce(
      new Error("Polling mechanism failed"),
    );

    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.logger.error).toHaveBeenCalledWith(
        {
          err: expect.any(Error),
        },
        "Scheduler polling wait failed",
      );
    });

    // Give the runner's loop time to finish.
    await runner.stop();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
  });

  it("handles concurrent stop requests without duplicate shutdown logs", async () => {
    const dependencies = createDependencies();
    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.wait).toHaveBeenCalledTimes(1);
    });

    await Promise.all([runner.stop(), runner.stop()]);

    expect(dependencies.logger.info).toHaveBeenCalledTimes(4);
    expect(dependencies.logger.info).toHaveBeenCalledWith(
      {},
      "Scheduler shutdown requested",
    );
    expect(dependencies.logger.info).toHaveBeenCalledWith(
      {},
      "Scheduler runner stopped",
    );
  });

  it("can restart after the previous loop has stopped", async () => {
    const dependencies = createDependencies();

    dependencies.wait.mockResolvedValueOnce(undefined);

    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(2);
    });

    await runner.stop();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(2);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(3);
    });

    await runner.stop();

    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(3);
  });

  it("waits for an active scheduling tick before completing shutdown", async () => {
    const dependencies = createDependencies();

    let resolveTick!: (value: { scheduledCount: number }) => void;

    dependencies.scheduleDueProbes.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTick = resolve;
        }),
    );

    const runner = createSchedulerRunner(dependencies);

    runner.start();

    await vi.waitFor(() => {
      expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
    });

    let shutdownCompleted = false;

    const shutdown = runner.stop().then(() => {
      shutdownCompleted = true;
    });

    // Shutdown must wait while the database operation is active.
    expect(shutdownCompleted).toBe(false);

    resolveTick({ scheduledCount: 1 });

    await shutdown;

    expect(shutdownCompleted).toBe(true);
    expect(dependencies.scheduleDueProbes).toHaveBeenCalledTimes(1);
    expect(dependencies.wait).not.toHaveBeenCalled();
  });
});
