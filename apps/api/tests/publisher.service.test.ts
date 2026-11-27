import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPublisherService } from "../src/publisher/publisher.service.js";
import type { ClaimedOutboxEvent } from "../src/publisher/publisher.types.js";

const validInput = {
  batchSize: 50,
  leaseMs: 30_000,
  publisherId: "publisher-test-1",
};

const claimedEvent: ClaimedOutboxEvent = {
  id: "dispatch-event-1",
  execution_id: "execution-1",
  event_type: "monitor.check.requested",
  publish_attempts: 1,
  publisher_fencing_token: "1",
  region_code: "ap-south-1",
};

describe("Publisher service", () => {
  let pool: Pool;
  let poolQuery: ReturnType<typeof vi.fn>;
  let client: PoolClient;
  let connect: ReturnType<typeof vi.fn>;
  let query: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    poolQuery = vi.fn();
    query = vi.fn();
    release = vi.fn();

    client = {
      query,
      release,
    } as unknown as PoolClient;

    connect = vi.fn().mockResolvedValue(client);

    pool = {
      connect,
      query: poolQuery,
    } as unknown as Pool;

    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      return {
        rows: [claimedEvent],
        rowCount: 1,
      };
    });
  });

  it("claims due outbox events and commits the transaction", async () => {
    const service = createPublisherService(pool);

    const result = await service.claimDueOutboxEvents(validInput);

    expect(result).toEqual({
      claimedCount: 1,
      events: [claimedEvent],
    });

    expect(query).toHaveBeenCalledTimes(3);

    const [beginCall, claimCall, commitCall] = query.mock.calls;

    expect(beginCall?.[0]).toBe("BEGIN");
    expect(commitCall?.[0]).toBe("COMMIT");

    expect(claimCall?.[0]).toContain("FOR UPDATE OF e SKIP LOCKED");

    expect(claimCall?.[0]).toContain(
      "publisher_fencing_token = e.publisher_fencing_token + 1",
    );

    expect(claimCall?.[0]).toContain(
      "publish_attempts = e.publish_attempts + 1",
    );

    expect(claimCall?.[1]).toEqual([
      validInput.batchSize,
      validInput.publisherId,
      validInput.leaseMs,
    ]);

    expect(release).toHaveBeenCalledOnce();
  });

  it("returns an empty result when no events are eligible", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    });

    const service = createPublisherService(pool);

    await expect(service.claimDueOutboxEvents(validInput)).resolves.toEqual({
      claimedCount: 0,
      events: [],
    });

    expect(query).toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an invalid batch size before acquiring a client", async () => {
    const service = createPublisherService(pool);

    await expect(
      service.claimDueOutboxEvents({
        ...validInput,
        batchSize: 0,
      }),
    ).rejects.toThrow("batch size");

    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a batch size above the maximum", async () => {
    const service = createPublisherService(pool);

    await expect(
      service.claimDueOutboxEvents({
        ...validInput,
        batchSize: 501,
      }),
    ).rejects.toThrow("batch size");

    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a non-integer batch size", async () => {
    const service = createPublisherService(pool);

    await expect(
      service.claimDueOutboxEvents({
        ...validInput,
        batchSize: 1.5,
      }),
    ).rejects.toThrow("batch size");

    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an invalid lease duration", async () => {
    const service = createPublisherService(pool);

    await expect(
      service.claimDueOutboxEvents({
        ...validInput,
        leaseMs: 0,
      }),
    ).rejects.toThrow("lease duration");

    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an empty publisher ID", async () => {
    const service = createPublisherService(pool);

    await expect(
      service.claimDueOutboxEvents({
        ...validInput,
        publisherId: "   ",
      }),
    ).rejects.toThrow("Publisher ID");

    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls back when the claim query fails", async () => {
    const claimError = new Error("Database claim failed");

    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN") {
        return { rows: [], rowCount: 0 };
      }

      if (sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      throw claimError;
    });

    const service = createPublisherService(pool);

    await expect(service.claimDueOutboxEvents(validInput)).rejects.toThrow(
      "Database claim failed",
    );

    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the client even when rollback fails", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN") {
        return { rows: [], rowCount: 0 };
      }

      if (sql === "ROLLBACK") {
        throw new Error("Rollback failed");
      }

      throw new Error("Claim failed");
    });

    const service = createPublisherService(pool);

    await expect(service.claimDueOutboxEvents(validInput)).rejects.toThrow(
      "Claim failed",
    );

    expect(release).toHaveBeenCalledOnce();
  });

  it("does not release a client when connection acquisition fails", async () => {
    connect.mockRejectedValueOnce(new Error("Connection unavailable"));

    const service = createPublisherService(pool);

    await expect(service.claimDueOutboxEvents(validInput)).rejects.toThrow(
      "Connection unavailable",
    );

    expect(release).not.toHaveBeenCalled();
  });

  const validAcknowledgementInput = {
    eventId: "dispatch-event-1",
    publisherId: "publisher-test-1",
    publisherFencingToken: "1",
  };

  const validReleaseInput = {
    eventId: "dispatch-event-1",
    publisherId: "publisher-test-1",
    publisherFencingToken: "1",
    errorMessage: "Redis connection failed",
  };

  describe("acknowledgePublishedEvent", () => {
    it("acknowledges an event owned by the current publisher", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [{ id: "dispatch-event-1" }],
        rowCount: 1,
      });

      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent(validAcknowledgementInput),
      ).resolves.toBe(true);

      expect(poolQuery).toHaveBeenCalledOnce();

      const [sql, params] = poolQuery.mock.calls[0]!;

      expect(sql).toContain("status = 'published'");
      expect(sql).toContain("locked_by = NULL");
      expect(sql).toContain("lease_expires_at = NULL");
      expect(sql).toContain("publisher_fencing_token = $3::bigint");
      expect(sql).toContain("lease_expires_at > clock_timestamp()");
      expect(sql).toContain("RETURNING id");

      expect(params).toEqual(["dispatch-event-1", "publisher-test-1", "1"]);
    });

    it("returns false when the publisher no longer owns the event", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent(validAcknowledgementInput),
      ).resolves.toBe(false);
    });

    it("returns false when the fencing token is stale", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent({
          ...validAcknowledgementInput,
          publisherFencingToken: "1",
        }),
      ).resolves.toBe(false);
    });

    it("returns false when the lease has expired", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent(validAcknowledgementInput),
      ).resolves.toBe(false);
    });

    it("returns false when the event is already published", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent(validAcknowledgementInput),
      ).resolves.toBe(false);
    });

    it("rejects an empty event ID before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent({
          ...validAcknowledgementInput,
          eventId: " ",
        }),
      ).rejects.toThrow("Outbox event ID");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("rejects an empty publisher ID before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent({
          ...validAcknowledgementInput,
          publisherId: " ",
        }),
      ).rejects.toThrow("Publisher ID");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("rejects an invalid fencing token before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent({
          ...validAcknowledgementInput,
          publisherFencingToken: "1.5",
        }),
      ).rejects.toThrow("fencing token");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("propagates database errors", async () => {
      poolQuery.mockRejectedValueOnce(
        new Error("Acknowledgement database failure"),
      );

      const service = createPublisherService(pool);

      await expect(
        service.acknowledgePublishedEvent(validAcknowledgementInput),
      ).rejects.toThrow("Acknowledgement database failure");
    });
  });

  describe("releaseFailedOutboxEvent", () => {
    it("releases a failed event and schedules exponential backoff", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [{ id: "dispatch-event-1" }],
        rowCount: 1,
      });

      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent(validReleaseInput),
      ).resolves.toBe(true);

      expect(poolQuery).toHaveBeenCalledOnce();

      const [sql, params] = poolQuery.mock.calls[0]!;

      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("available_at = clock_timestamp()");
      expect(sql).toContain("GREATEST(publish_attempts - 1, 0)");
      expect(sql).toContain("60000::bigint");
      expect(sql).toContain("locked_by = NULL");
      expect(sql).toContain("lease_expires_at = NULL");
      expect(sql).toContain("last_error = $4");
      expect(sql).toContain("publisher_fencing_token = $3::bigint");
      expect(sql).toContain("lease_expires_at > clock_timestamp()");
      expect(sql).toContain("RETURNING id");

      expect(params).toEqual([
        "dispatch-event-1",
        "publisher-test-1",
        "1",
        "Redis connection failed",
      ]);
    });

    it("returns false when the publisher no longer owns the event", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent(validReleaseInput),
      ).resolves.toBe(false);
    });

    it("normalizes control characters in the stored error message", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [{ id: "dispatch-event-1" }],
        rowCount: 1,
      });

      const service = createPublisherService(pool);

      await service.releaseFailedOutboxEvent({
        ...validReleaseInput,
        errorMessage: " Redis\nconnection\tfailed ",
      });

      const [, params] = poolQuery.mock.calls[0]!;

      expect(params?.[3]).toBe("Redis connection failed");
    });

    it("limits the stored error message to 1000 characters", async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [{ id: "dispatch-event-1" }],
        rowCount: 1,
      });

      const service = createPublisherService(pool);

      await service.releaseFailedOutboxEvent({
        ...validReleaseInput,
        errorMessage: "x".repeat(1500),
      });

      const [, params] = poolQuery.mock.calls[0]!;

      expect(params?.[3]).toHaveLength(1000);
    });

    it("rejects an empty event ID before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent({
          ...validReleaseInput,
          eventId: " ",
        }),
      ).rejects.toThrow("Outbox event ID");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("rejects an empty publisher ID before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent({
          ...validReleaseInput,
          publisherId: " ",
        }),
      ).rejects.toThrow("Publisher ID");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("rejects an invalid fencing token before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent({
          ...validReleaseInput,
          publisherFencingToken: "1.5",
        }),
      ).rejects.toThrow("fencing token");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("rejects an empty error message before querying the database", async () => {
      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent({
          ...validReleaseInput,
          errorMessage: " ",
        }),
      ).rejects.toThrow("error message");

      expect(poolQuery).not.toHaveBeenCalled();
    });

    it("propagates database errors", async () => {
      poolQuery.mockRejectedValueOnce(new Error("Release database failure"));

      const service = createPublisherService(pool);

      await expect(
        service.releaseFailedOutboxEvent(validReleaseInput),
      ).rejects.toThrow("Release database failure");
    });
  });
});
