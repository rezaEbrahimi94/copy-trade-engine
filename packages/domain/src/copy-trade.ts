import { isValidAmount, type MinorUnits } from './money';
import { err, ok, type Result } from './result';

export interface Trade {
  readonly id: string;
  readonly traderId: string;
  readonly amount: MinorUnits;
}

export interface Follower {
  readonly id: string;
  readonly balance: MinorUnits;
  readonly remainingAllocation: MinorUnits;
  readonly copyingEnabled: boolean;
}

export const REJECTION_REASONS = [
  'FOLLOWER_NOT_FOUND',
  'INVALID_AMOUNT',
  'SELF_COPY',
  'COPYING_DISABLED',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_ALLOCATION',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface CopyDecision {
  readonly follower: Follower;
  readonly amount: MinorUnits;
}

/**
 * Pure eligibility rule for copying a trade. Returns the follower state after the
 * debit when eligible. Checks are ordered so the most fundamental reason wins.
 */
export function decideCopyTrade(
  trade: Trade,
  follower: Follower | undefined,
): Result<CopyDecision, RejectionReason> {
  if (follower === undefined) return err('FOLLOWER_NOT_FOUND');
  if (!isValidAmount(trade.amount)) return err('INVALID_AMOUNT');
  if (trade.traderId === follower.id) return err('SELF_COPY');
  if (!follower.copyingEnabled) return err('COPYING_DISABLED');
  if (follower.balance < trade.amount) return err('INSUFFICIENT_BALANCE');
  if (follower.remainingAllocation < trade.amount) return err('INSUFFICIENT_ALLOCATION');

  return ok({
    amount: trade.amount,
    follower: {
      ...follower,
      balance: follower.balance - trade.amount,
      remainingAllocation: follower.remainingAllocation - trade.amount,
    },
  });
}

/** Reverses a previously applied debit (compensation for a failed downstream execution). */
export function refundCopyTrade(follower: Follower, amount: MinorUnits): Follower {
  return {
    ...follower,
    balance: follower.balance + amount,
    remainingAllocation: follower.remainingAllocation + amount,
  };
}
