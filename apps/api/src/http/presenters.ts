import type {
  FollowerView,
  ProcessedEvent,
  ReconciliationReport,
  TradeRecord,
  TradeView,
} from '@copy-trade/application';
import type {
  FollowerDto,
  FollowerStateDto,
  FollowerTradeDto,
  InstanceDto,
  ProcessedEventDto,
  RejectionReason as ContractRejectionReason,
  ReconciliationReportDto,
  TradeViewDto,
} from '@copy-trade/contracts';
import type { InstanceStatus } from '@copy-trade/db';
import type { Follower, FollowerTrade, RejectionReason } from '@copy-trade/domain';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time proof that the HTTP contract and the domain agree on rejection reasons. */
export const rejectionReasonsInSync: Same<RejectionReason, ContractRejectionReason> = true;

export const presentFollower = (f: FollowerView): FollowerDto => ({
  id: f.id,
  balance: f.balance,
  remainingAllocation: f.remainingAllocation,
  openingBalance: f.openingBalance,
  openingAllocation: f.openingAllocation,
  copyingEnabled: f.copyingEnabled,
  traderIds: [...f.traderIds],
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
  handledBy: t.handledBy,
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

export const presentTradeRecord = (t: TradeRecord) => ({
  id: t.id,
  traderId: t.traderId,
  amount: t.amount,
  createdAt: t.createdAt.toISOString(),
});

export const presentProcessedEvent = (p: ProcessedEvent): ProcessedEventDto => ({
  eventId: p.eventId,
  outcome: p.outcome,
  reason: p.reason,
  followerTradeId: p.followerTradeId,
  handledBy: p.handledBy,
  topic: p.source?.topic ?? null,
  partition: p.source?.partition ?? null,
  offset: p.source?.offset ?? null,
  processedAt: p.processedAt.toISOString(),
});

export const presentTradeView = (v: TradeView): TradeViewDto => ({
  trade: presentTradeRecord(v.trade),
  requests: v.requests.map((r) => ({
    eventId: r.eventId,
    followerId: r.followerId,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    processed: r.processed === null ? null : presentProcessedEvent(r.processed),
  })),
});

export const presentInstance = (i: InstanceStatus): InstanceDto => ({
  id: i.id,
  kind: i.kind,
  startedAt: i.startedAt.toISOString(),
  lastSeenAt: i.lastSeenAt.toISOString(),
  stoppedAt: i.stoppedAt?.toISOString() ?? null,
  alive: i.alive,
  partitions: [...i.partitions],
});

export const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  FOLLOWER_NOT_FOUND: 'Follower does not exist',
  INVALID_AMOUNT: 'Trade amount must be a positive integer number of minor units',
  SELF_COPY: 'A trader cannot copy their own trade',
  COPYING_DISABLED: 'Follower has copy trading disabled',
  INSUFFICIENT_BALANCE: 'Follower balance is lower than the trade amount',
  INSUFFICIENT_ALLOCATION: 'Follower remaining allocation is lower than the trade amount',
};
