import type { MinorUnits } from './money';
import { err, ok, type Result } from './result';

export const FOLLOWER_TRADE_STATUSES = ['pending', 'executed', 'failed'] as const;
export type FollowerTradeStatus = (typeof FOLLOWER_TRADE_STATUSES)[number];

/** Append-only ledger row: one per (tradeId, followerId). Only `status` ever changes. */
export interface FollowerTrade {
  readonly id: string;
  readonly tradeId: string;
  readonly traderId: string;
  readonly followerId: string;
  readonly amount: MinorUnits;
  readonly status: FollowerTradeStatus;
  readonly idempotencyKey: string | null;
  /** API replica or worker that wrote the row (null for rows written before tracking). */
  readonly handledBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ExecutionOutcome = 'executed' | 'failed';

export interface InvalidTransition {
  readonly from: FollowerTradeStatus;
  readonly to: ExecutionOutcome;
}

/** Only pending entries may settle; settled entries are terminal. */
export function transitionStatus(
  from: FollowerTradeStatus,
  to: ExecutionOutcome,
): Result<ExecutionOutcome, InvalidTransition> {
  return from === 'pending' ? ok(to) : err({ from, to });
}

/**
 * A ledger entry holds funds while pending or executed. A failed entry has been
 * compensated (refunded), so it no longer counts against balance or allocation.
 */
export const holdsFunds = (status: FollowerTradeStatus): boolean => status !== 'failed';
