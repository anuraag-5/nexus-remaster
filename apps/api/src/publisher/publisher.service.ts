import type { Pool, PoolClient } from "pg";

import { logger } from "../lib/logger.js";
import type {
  AcknowledgePublishedEventInput,
  ClaimOutboxEventsInput,
  ClaimOutboxEventsResult,
  ClaimedOutboxEvent,
  ReleaseOutboxEventInput,
} from "./publisher.types.js";

const MAX_BATCH_SIZE = 500;
const MAX_ERROR_MESSAGE_LENGTH = 1000;

function normalizeErrorMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export class InvalidPublisherClaimInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublisherClaimInputError";
  }
}

export class InvalidPublisherAcknowledgementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublisherAcknowledgementInputError";
  }
}

export class InvalidPublisherReleaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPublisherReleaseInputError";
  }
}

function validateAcknowledgementInput(
  input: AcknowledgePublishedEventInput,
): void {
  if (!input.eventId.trim()) {
    throw new InvalidPublisherAcknowledgementInputError(
      "Outbox event ID must not be empty",
    );
  }

  if (!input.publisherId.trim()) {
    throw new InvalidPublisherAcknowledgementInputError(
      "Publisher ID must not be empty",
    );
  }

  if (!/^\d+$/.test(input.publisherFencingToken)) {
    throw new InvalidPublisherAcknowledgementInputError(
      "Publisher fencing token must be a non-negative integer string",
    );
  }
}

function validateInput(input: ClaimOutboxEventsInput): void {
  if (
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > MAX_BATCH_SIZE
  ) {
    throw new InvalidPublisherClaimInputError(
      `Publisher batch size must be an integer between 1 and ${MAX_BATCH_SIZE}`,
    );
  }

  if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
    throw new InvalidPublisherClaimInputError(
      "Publisher lease duration must be a positive integer",
    );
  }

  if (!input.publisherId.trim()) {
    throw new InvalidPublisherClaimInputError("Publisher ID must not be empty");
  }
}

function validateReleaseInput(input: ReleaseOutboxEventInput): void {
  if (!input.eventId.trim()) {
    throw new InvalidPublisherReleaseInputError(
      "Outbox event ID must not be empty",
    );
  }

  if (!input.publisherId.trim()) {
    throw new InvalidPublisherReleaseInputError(
      "Publisher ID must not be empty",
    );
  }

  if (!/^\d+$/.test(input.publisherFencingToken)) {
    throw new InvalidPublisherReleaseInputError(
      "Publisher fencing token must be a non-negative integer string",
    );
  }

  if (!input.errorMessage.trim()) {
    throw new InvalidPublisherReleaseInputError(
      "Publisher error message must not be empty",
    );
  }
}

async function claimOutboxEvents(
  client: PoolClient,
  input: ClaimOutboxEventsInput,
): Promise<ClaimedOutboxEvent[]> {
  const result = await client.query<ClaimedOutboxEvent>(
    `
      WITH candidates AS (
        SELECT e.id
        FROM outbox_events AS e
        INNER JOIN monitor_executions AS x
          ON x.id = e.execution_id
        INNER JOIN monitor_probes AS p
          ON p.id = x.probe_id
        INNER JOIN monitors AS m
          ON m.id = p.monitor_id
        INNER JOIN monitor_regions AS r
          ON r.code = p.region_code
        WHERE
          (
            (
              e.status = 'pending'
              AND e.available_at <= transaction_timestamp()
            )
            OR
            (
              e.status = 'publishing'
              AND e.lease_expires_at <= transaction_timestamp()
            )
          )
          AND x.status IN ('pending', 'queued')
          AND p.is_enabled = TRUE
          AND m.is_enabled = TRUE
          AND r.is_enabled = TRUE
        ORDER BY e.available_at ASC, e.created_at ASC, e.id ASC
        LIMIT $1
        FOR UPDATE OF e SKIP LOCKED
      ),
      claimed AS (
        UPDATE outbox_events AS e
        SET
          status = 'publishing',
          locked_by = $2,
          lease_expires_at =
            transaction_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
          publish_attempts = e.publish_attempts + 1,
          publisher_fencing_token = e.publisher_fencing_token + 1,
          updated_at = transaction_timestamp()
        FROM candidates AS c
        WHERE e.id = c.id
        RETURNING
          e.id,
          e.execution_id,
          e.event_type,
          e.publish_attempts,
          e.publisher_fencing_token
      )
      SELECT
        c.id,
        c.execution_id,
        c.event_type,
        c.publish_attempts,
        c.publisher_fencing_token,
        p.region_code
      FROM claimed AS c
      INNER JOIN monitor_executions AS x
        ON x.id = c.execution_id
      INNER JOIN monitor_probes AS p
        ON p.id = x.probe_id
      ORDER BY c.id ASC
    `,
    [input.batchSize, input.publisherId, input.leaseMs],
  );

  return result.rows;
}

export function createPublisherService(pool: Pool) {
  async function claimDueOutboxEvents(
    input: ClaimOutboxEventsInput,
  ): Promise<ClaimOutboxEventsResult> {
    validateInput(input);

    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const events = await claimOutboxEvents(client, input);

      await client.query("COMMIT");
      transactionStarted = false;

      return {
        claimedCount: events.length,
        events,
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error(
            { err: rollbackError },
            "Failed to roll back publisher claim transaction",
          );
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async function acknowledgePublishedEvent(
    input: AcknowledgePublishedEventInput,
  ): Promise<boolean> {
    validateAcknowledgementInput(input);

    const result = await pool.query<{ id: string }>(
      `
      UPDATE outbox_events
      SET
        status = 'published',
        published_at = transaction_timestamp(),
        locked_by = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = transaction_timestamp()
      WHERE
        id = $1
        AND status = 'publishing'
        AND locked_by = $2
        AND publisher_fencing_token = $3::bigint
        AND lease_expires_at > clock_timestamp()
      RETURNING id
    `,
      [input.eventId, input.publisherId, input.publisherFencingToken],
    );

    return result.rows.length === 1;
  }

  async function releaseFailedOutboxEvent(
    input: ReleaseOutboxEventInput,
  ): Promise<boolean> {
    validateReleaseInput(input);

    const errorMessage = normalizeErrorMessage(input.errorMessage);

    if (!errorMessage) {
      throw new InvalidPublisherReleaseInputError(
        "Publisher error message must contain printable characters",
      );
    }

    const result = await pool.query<{ id: string }>(
      `
      UPDATE outbox_events
      SET
        status = 'pending',
        available_at = clock_timestamp() +
          (
            LEAST(
              1000::bigint * (
                1::bigint << LEAST(
                  GREATEST(publish_attempts - 1, 0),
                  6
                )
              ),
              60000::bigint
            ) * INTERVAL '1 millisecond'
          ),
        locked_by = NULL,
        lease_expires_at = NULL,
        last_error = $4,
        updated_at = transaction_timestamp()
      WHERE
        id = $1
        AND status = 'publishing'
        AND locked_by = $2
        AND publisher_fencing_token = $3::bigint
        AND lease_expires_at > clock_timestamp()
      RETURNING id
    `,
      [
        input.eventId,
        input.publisherId,
        input.publisherFencingToken,
        errorMessage,
      ],
    );

    return result.rows.length === 1;
  }
  return {
    claimDueOutboxEvents,
    acknowledgePublishedEvent,
    releaseFailedOutboxEvent,
  };
}
