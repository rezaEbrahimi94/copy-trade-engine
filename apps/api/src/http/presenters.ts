import type { FollowerRecord, ReconciliationReport } from '@copy-trade/application';
import type {
  FollowerDto,
  FollowerStateDto,
  FollowerTradeDto,
  RejectionReason as ContractRejectionReason,
  ReconciliationReportDto,
} from '@copy-trade/contracts';
import type { Follower, FollowerTrade, RejectionReason } from '@copy-trade/domain';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time proof that the HTTP contract and the domain agree on rejection reasons. */
export const rejectionReasonsInSync: Same<RejectionReason, ContractRejectionReason> = true;

export const presentFollower = (f: FollowerRecord): FollowerDto => ({
  id: f.id,
  balance: f.balance,
  remainingAllocation: f.remainingAllocation,
  openingBalance: f.openingBalance,
  openingAllocation: f.openingAllocation,
  copyingEnabled: f.copyingEnabled,
  createdAt: f.createdAt.toISOString(),
  updatedAt: f.updatedAt.toISOString(),
});

export const presentFollowerState = (f: Follower): FollowerStateDto => ({
  id: f.id,
  balance: f.balance,
  remainingAllocation: f.remainingAllocation,
  copyingEnabled: f.copyingEnabled,
});

export const presentFollowerTrade = (t: FollowerTrade): FollowerTradeDto => ({
  id: t.id,
  tradeId: t.tradeId,
  traderId: t.traderId,
  followerId: t.followerId,
  amount: t.amount,
  status: t.status,
  idempotencyKey: t.idempotencyKey,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const presentReconciliation = (r: ReconciliationReport): ReconciliationReportDto => ({
  checkedAt: r.checkedAt.toISOString(),
  consistent: r.summary.driftedFollowers === 0 && r.summary.duplicateKeys === 0,
  summary: r.summary,
  stuckPending: r.stuckPending,
  drifted: [...r.drifted],
});

export const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  FOLLOWER_NOT_FOUND: 'Follower does not exist',
  INVALID_AMOUNT: 'Trade amount must be a positive integer number of minor units',
  SELF_COPY: 'A trader cannot copy their own trade',
  COPYING_DISABLED: 'Follower has copy trading disabled',
  INSUFFICIENT_BALANCE: 'Follower balance is lower than the trade amount',
  INSUFFICIENT_ALLOCATION: 'Follower remaining allocation is lower than the trade amount',
};
