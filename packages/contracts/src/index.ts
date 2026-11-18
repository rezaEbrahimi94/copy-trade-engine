import { z } from 'zod';

/**
 * HTTP contracts shared by the API (request validation + response serialization) and the
 * web client (typed requests + runtime response parsing). Money is integer minor units.
 * Shape is validated here; business rules (e.g. amount > 0) belong to the domain.
 */

export const API_PREFIX = '/v1';

const Id = z.string().trim().min(1).max(128);
const MinorUnits = z.int().describe('Integer amount in minor units (e.g. cents)');
const NonNegativeMinorUnits = z.int().min(0);
const Timestamp = z.iso.datetime();

export const REJECTION_REASONS = [
  'FOLLOWER_NOT_FOUND',
  'INVALID_AMOUNT',
  'SELF_COPY',
  'COPYING_DISABLED',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_ALLOCATION',
] as const;
export const RejectionReasonSchema = z.enum(REJECTION_REASONS);
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

export const TradeSchema = z.strictObject({
  id: Id,
  traderId: Id,
  amount: MinorUnits,
});
export type TradeDto = z.infer<typeof TradeSchema>;

export const FollowerSchema = z.strictObject({
  id: Id,
  balance: NonNegativeMinorUnits,
  remainingAllocation: NonNegativeMinorUnits,
  openingBalance: NonNegativeMinorUnits,
  openingAllocation: NonNegativeMinorUnits,
  copyingEnabled: z.boolean(),
  traderIds: z.array(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type FollowerDto = z.infer<typeof FollowerSchema>;

export const FollowerStateSchema = FollowerSchema.pick({
  id: true,
  balance: true,
  remainingAllocation: true,
  copyingEnabled: true,
});
export type FollowerStateDto = z.infer<typeof FollowerStateSchema>;

export const FollowerTradeStatusSchema = z.enum(['pending', 'executed', 'failed']);

export const FollowerTradeSchema = z.strictObject({
  id: Id,
  tradeId: Id,
  traderId: Id,
  followerId: Id,
  amount: MinorUnits,
  status: FollowerTradeStatusSchema,
  idempotencyKey: z.string().nullable(),
  handledBy: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type FollowerTradeDto = z.infer<typeof FollowerTradeSchema>;

export const CreateFollowerRequestSchema = z.strictObject({
  balance: NonNegativeMinorUnits,
  allocation: NonNegativeMinorUnits,
  copyingEnabled: z.boolean().default(true),
  traderIds: z.array(Id).max(50).default([]),
});
export type CreateFollowerRequest = z.input<typeof CreateFollowerRequestSchema>;

export const UpdateFollowerRequestSchema = z.strictObject({
  copyingEnabled: z.boolean(),
});
export type UpdateFollowerRequest = z.infer<typeof UpdateFollowerRequestSchema>;

export const FollowerParamsSchema = z.strictObject({ followerId: Id });

export const FollowerListSchema = z.strictObject({ items: z.array(FollowerSchema) });
export const FollowerTradeListSchema = z.strictObject({ items: z.array(FollowerTradeSchema) });

export const CopyTradeRequestSchema = z.strictObject({
  trade: TradeSchema,
  followerId: Id,
});
export type CopyTradeRequest = z.infer<typeof CopyTradeRequestSchema>;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Every API response carries the replica that served it. */
export const INSTANCE_ID_HEADER = 'x-instance-id';
export const CopyTradeHeadersSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER]: z.string().trim().min(1).max(255).optional(),
});

/** 201 (copied) and 200 (duplicate) share one shape; duplicates return the original record. */
export const CopyTradeAcceptedSchema = z.strictObject({
  outcome: z.enum(['copied', 'duplicate']),
  followerTrade: FollowerTradeSchema,
  follower: FollowerStateSchema,
});

export const CopyTradeRejectedSchema = z.strictObject({
  outcome: z.literal('rejected'),
  reason: RejectionReasonSchema,
  message: z.string(),
});

export const IdempotencyConflictSchema = z.strictObject({
  outcome: z.literal('idempotency_key_conflict'),
  message: z.string(),
  followerTrade: FollowerTradeSchema,
});

export const CopyTradeResponseSchema = z.discriminatedUnion('outcome', [
  CopyTradeAcceptedSchema,
  CopyTradeRejectedSchema,
  IdempotencyConflictSchema,
]);
export type CopyTradeResponse = z.infer<typeof CopyTradeResponseSchema>;

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const FollowerReconciliationSchema = z.strictObject({
  followerId: Id,
  expectedBalance: z.int(),
  actualBalance: z.int(),
  balanceDrift: z.int(),
  expectedAllocation: z.int(),
  actualAllocation: z.int(),
  allocationDrift: z.int(),
  duplicateKeyCount: z.int(),
  negative: z.boolean(),
  consistent: z.boolean(),
});

export const ReconciliationReportSchema = z.strictObject({
  checkedAt: Timestamp,
  consistent: z.boolean(),
  summary: z.strictObject({
    followersChecked: z.int(),
    driftedFollowers: z.int(),
    totalAbsoluteDrift: z.int(),
    duplicateKeys: z.int(),
  }),
  stuckPending: z.int(),
  drifted: z.array(FollowerReconciliationSchema),
});
export type ReconciliationReportDto = z.infer<typeof ReconciliationReportSchema>;

export const RedriveResponseSchema = z.strictObject({ requeued: z.int() });

export const HealthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'unavailable']),
  checks: z.record(z.string(), z.enum(['ok', 'failed'])),
});

// ---------------------------------------------------------------------------------------------
// Event-driven flow: trades fan out to followers over the message bus.
// ---------------------------------------------------------------------------------------------

export const OpenTradeRequestSchema = TradeSchema;
export type OpenTradeRequest = z.infer<typeof OpenTradeRequestSchema>;

export const TradeRecordSchema = z.strictObject({
  id: Id,
  traderId: Id,
  amount: MinorUnits,
  createdAt: Timestamp,
});

/** 202 accepted (events enqueued) and 200 duplicate (nothing new enqueued) share one shape. */
export const OpenTradeAcceptedSchema = z.strictObject({
  outcome: z.enum(['accepted', 'duplicate']),
  trade: TradeRecordSchema,
  requestedFollowerIds: z.array(Id),
});
export const TradeConflictSchema = z.strictObject({
  outcome: z.literal('trade_conflict'),
  message: z.string(),
  trade: TradeRecordSchema,
});
export const OpenTradeResponseSchema = z.discriminatedUnion('outcome', [
  OpenTradeAcceptedSchema,
  TradeConflictSchema,
]);
export type OpenTradeResponse = z.infer<typeof OpenTradeResponseSchema>;

export const PROCESSED_OUTCOMES = [
  'copied',
  'duplicate',
  'rejected',
  'idempotency_key_conflict',
] as const;

export const ProcessedEventSchema = z.strictObject({
  eventId: Id,
  outcome: z.enum(PROCESSED_OUTCOMES),
  reason: RejectionReasonSchema.nullable(),
  followerTradeId: z.string().nullable(),
  handledBy: z.string(),
  topic: z.string().nullable(),
  partition: z.int().nullable(),
  offset: z.string().nullable(),
  processedAt: Timestamp,
});
export type ProcessedEventDto = z.infer<typeof ProcessedEventSchema>;

export const TradeViewSchema = z.strictObject({
  trade: TradeRecordSchema,
  requests: z.array(
    z.strictObject({
      eventId: Id,
      followerId: Id,
      publishedAt: Timestamp.nullable(),
      processed: ProcessedEventSchema.nullable(),
    }),
  ),
});
export type TradeViewDto = z.infer<typeof TradeViewSchema>;
export const TradeViewListSchema = z.strictObject({ items: z.array(TradeViewSchema) });
export const TradeParamsSchema = z.strictObject({ tradeId: Id });
export const RepublishResponseSchema = z.strictObject({ republished: z.int() });

export const InstanceSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['api', 'worker']),
  startedAt: Timestamp,
  lastSeenAt: Timestamp,
  stoppedAt: Timestamp.nullable(),
  alive: z.boolean(),
  partitions: z.array(z.int()),
});
export type InstanceDto = z.infer<typeof InstanceSchema>;
export const InstanceListSchema = z.strictObject({ items: z.array(InstanceSchema) });

export const SystemInfoSchema = z.strictObject({
  instanceId: z.string(),
  eventBus: z.boolean(),
  consoleUrl: z.string().nullable(),
  consumerGroup: z.string(),
  topics: z.strictObject({
    requested: z.string(),
    completed: z.string(),
    rejected: z.string(),
    deadLetter: z.string(),
  }),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

/** Kafka topics. `requested` is keyed by follower id, so one follower's events stay ordered. */
export const TOPICS = {
  requested: 'copy-trade.requested',
  completed: 'copy-trade.completed',
  rejected: 'copy-trade.rejected',
  deadLetter: 'copy-trade.requested.dlq',
} as const;
export const CONSUMER_GROUP = 'copy-trade-workers';

export const EVENT_HEADERS = {
  eventId: 'event-id',
  eventType: 'event-type',
  causationId: 'causation-id',
  producer: 'producer',
  dlqError: 'dlq-error',
  dlqReason: 'dlq-reason',
  dlqAttempts: 'dlq-attempts',
  dlqSource: 'dlq-source',
} as const;

export const TradeOpenedEventSchema = z.strictObject({
  eventId: Id,
  type: z.literal('TradeOpened'),
  version: z.literal(1),
  occurredAt: Timestamp,
  trade: TradeSchema,
  followerId: Id,
});
export type TradeOpenedEventDto = z.infer<typeof TradeOpenedEventSchema>;

/**
 * Published by a worker after the copy transaction commits. `eventId` is derived from the
 * request event id, so a redelivered request republishes an identical result event.
 */
export const CopyTradeResultEventSchema = z.strictObject({
  eventId: Id,
  type: z.enum(['CopyTradeCompleted', 'CopyTradeRejected']),
  version: z.literal(1),
  causationId: Id,
  occurredAt: Timestamp,
  tradeId: Id,
  followerId: Id,
  outcome: z.enum(PROCESSED_OUTCOMES),
  reason: RejectionReasonSchema.nullable(),
  followerTradeId: z.string().nullable(),
  handledBy: z.string(),
  redelivered: z.boolean(),
});
export type CopyTradeResultEvent = z.infer<typeof CopyTradeResultEventSchema>;
