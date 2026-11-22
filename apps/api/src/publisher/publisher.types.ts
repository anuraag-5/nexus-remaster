export type ClaimOutboxEventsInput = {
  batchSize: number;
  leaseMs: number;
  publisherId: string;
};

export type ClaimedOutboxEvent = {
  id: string;
  execution_id: string;
  event_type: string;
  publish_attempts: number;
  publisher_fencing_token: string;
  region_code: string;
};

export type ClaimOutboxEventsResult = {
  claimedCount: number;
  events: ClaimedOutboxEvent[];
};

export type AcknowledgePublishedEventInput = {
  eventId: string;
  publisherId: string;
  publisherFencingToken: string;
};