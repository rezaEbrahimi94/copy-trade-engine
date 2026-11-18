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
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type FollowerTradeDto = z.infer<typeof FollowerTradeSchema>;

export const CreateFollowerRequestSchema = z.strictObject({
  balance: NonNegativeMinorUnits,
  allocation: NonNegativeMinorUnits,
  copyingEnabled: z.boolean().default(true),
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
