import { setTimeout as delay } from "node:timers/promises";

import type { SchedulerConfig } from "./scheduler.config.js";
import type { ScheduleDueProbesResult } from "./scheduler.types.js";

type SchedulerLogger = {
  info: (data: object, message: string) => void;
  error: (data: object, message: string) => void;
};

type SchedulerRunnerDependencies = {
  config: SchedulerConfig;

  scheduleDueProbes: (input: {
    batchSize: number;
  }) => Promise<ScheduleDueProbesResult>;

  logger: SchedulerLogger;

  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function createSchedulerRunner(
  dependencies: SchedulerRunnerDependencies,
) {
  const wait =
    dependencies.wait ??
    (async (milliseconds: number, signal: AbortSignal) => {
      await delay(milliseconds, undefined, { signal });
    });

  let loopPromise: Promise<void> | undefined;
  let stopController: AbortController | undefined;
  let stopPromise: Promise<void> | undefined;

  async function runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const startedAt = Date.now();

      try {
        const result = await dependencies.scheduleDueProbes({
          batchSize: dependencies.config.SCHEDULER_BATCH_SIZE,
        });

        dependencies.logger.info(
          {
            scheduledCount: result.scheduledCount,
            durationMs: Date.now() - startedAt,
          },
          "Scheduler tick completed",
        );
      } catch (error) {
        dependencies.logger.error(
          {
            err: error,
            durationMs: Date.now() - startedAt,
          },
          "Scheduler tick failed",
        );
      }

      if (signal.aborted) {
        break;
      }

      try {
        await wait(dependencies.config.SCHEDULER_POLL_INTERVAL_MS, signal);
      } catch (error) {
        if (signal.aborted) {
          break;
        }

        dependencies.logger.error(
          { err: error },
          "Scheduler polling wait failed",
        );

        // An unexpected polling failure must not create a tight loop.
        break;
      }
    }
  }

  function start(): void {
    if (loopPromise) {
      return;
    }

    const controller = new AbortController();
    stopController = controller;

    loopPromise = runLoop(controller.signal).finally(() => {
      loopPromise = undefined;
      stopController = undefined;
    });

    dependencies.logger.info(
      {
        pollIntervalMs: dependencies.config.SCHEDULER_POLL_INTERVAL_MS,
        batchSize: dependencies.config.SCHEDULER_BATCH_SIZE,
      },
      "Scheduler runner started",
    );
  }

  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }

    const activeLoop = loopPromise;

    if (!activeLoop) {
      return Promise.resolve();
    }

    dependencies.logger.info({}, "Scheduler shutdown requested");

    stopController?.abort();

    stopPromise = activeLoop
      .then(() => {
        dependencies.logger.info({}, "Scheduler runner stopped");
      })
      .finally(() => {
        stopPromise = undefined;
      });

    return stopPromise;
  }

  return {
    start,
    stop,
  };
}
