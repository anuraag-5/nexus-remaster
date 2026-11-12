import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    listeners: Map<string, (error: Error) => void>;
  }>,
  loggerError: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class {
    options: Record<string, unknown>;
    listeners = new Map<string, (error: Error) => void>();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.instances.push(this);
    }

    on(event: string, listener: (error: Error) => void) {
      this.listeners.set(event, listener);
      return this;
    }
  },
}));

vi.mock("../src/lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
  },
}));

import { createDatabasePool } from "../src/lib/db/create-pool.js";

describe("createDatabasePool", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    mocks.loggerError.mockClear();
  });

  it("creates a pool with the supplied configuration and defaults", () => {
    createDatabasePool({
      connectionString: "postgresql://user:password@localhost:5432/nexus",
      max: 5,
      applicationName: "nexus-worker",
    });

    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]?.options).toEqual({
      connectionString: "postgresql://user:password@localhost:5432/nexus",
      max: 5,
      application_name: "nexus-worker",
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it("uses explicitly supplied timeout values", () => {
    createDatabasePool({
      connectionString: "postgresql://user:password@localhost:5432/nexus",
      max: 3,
      applicationName: "nexus-scheduler",
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
    });

    expect(mocks.instances[0]?.options).toMatchObject({
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
    });
  });

  it("creates independent pools on separate calls", () => {
    const first = createDatabasePool({
      connectionString: "postgresql://user:password@localhost:5432/nexus",
      max: 5,
      applicationName: "nexus-api",
    });

    const second = createDatabasePool({
      connectionString: "postgresql://user:password@localhost:5432/nexus",
      max: 3,
      applicationName: "nexus-scheduler",
    });

    expect(first).not.toBe(second);
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0]).not.toBe(mocks.instances[1]);
  });

  it.each([
    ["empty connection string", { connectionString: " " }],
    ["zero pool size", { max: 0 }],
    ["negative pool size", { max: -1 }],
    ["fractional pool size", { max: 1.5 }],
    ["empty application name", { applicationName: " " }],
    ["negative idle timeout", { idleTimeoutMillis: -1 }],
    ["fractional idle timeout", { idleTimeoutMillis: 1.5 }],
    ["zero connection timeout", { connectionTimeoutMillis: 0 }],
    ["fractional connection timeout", { connectionTimeoutMillis: 1.5 }],
  ])("rejects %s", (_description, override) => {
    expect(() =>
      createDatabasePool({
        connectionString: "postgresql://user:password@localhost:5432/nexus",
        max: 5,
        applicationName: "nexus-test",
        ...override,
      }),
    ).toThrow();
  });

  it("logs unexpected errors from idle PostgreSQL clients", () => {
    createDatabasePool({
      connectionString: "postgresql://user:password@localhost:5432/nexus",
      max: 5,
      applicationName: "nexus-worker",
    });

    const listener = mocks.instances[0]?.listeners.get("error");
    expect(listener).toBeDefined();

    const error = new Error("Unexpected idle client failure");
    listener?.(error);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        err: error,
        applicationName: "nexus-worker",
      },
      "Unexpected error on an idle PostgreSQL client",
    );
  });
});
