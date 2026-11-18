import type {
  Follower,
  FollowerLedgerSnapshot,
  FollowerTrade,
  FollowerTradeStatus,
  MinorUnits,
} from '@copy-trade/domain';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export type Sleep = (ms: number) => Promise<void>;

/** Persisted follower: the domain view plus immutable opening amounts used by reconciliation. */
export interface FollowerRecord extends Follower {
  readonly openingBalance: MinorUnits;
  readonly openingAllocation: MinorUnits;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OutboxMessage {
  readonly id: string;
  readonly followerTradeId: string;
  readonly attempts: number;
  readonly availableAt: Date;
}

/** Operations available inside a single copy-trade database transaction. */
export interface CopyTradeTransaction {
  /** Reads the follower and holds an exclusive row lock until commit/rollback. */
  lockFollower(followerId: string): Promise<FollowerRecord | undefined>;
  findFollowerTrade(tradeId: string, followerId: string): Promise<FollowerTrade | undefined>;
  findFollowerTradeByIdempotencyKey(key: string): Promise<FollowerTrade | undefined>;
  saveFollowerBalances(follower: Follower, now: Date): Promise<void>;
  /** Inserts the ledger row; resolves `undefined` when a unique key already exists. */
  insertFollowerTrade(entry: FollowerTrade): Promise<FollowerTrade | undefined>;
  enqueueExecution(message: OutboxMessage): Promise<void>;
}

export interface TransactionRunner<Tx> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export type CopyTradeUnitOfWork = TransactionRunner<CopyTradeTransaction>;

export interface FollowerRepository {
  create(record: FollowerRecord): Promise<FollowerRecord>;
  findById(id: string): Promise<FollowerRecord | undefined>;
  list(limit: number): Promise<readonly FollowerRecord[]>;
  setCopyingEnabled(id: string, enabled: boolean, now: Date): Promise<FollowerRecord | undefined>;
  listTrades(followerId: string, limit: number): Promise<readonly FollowerTrade[]>;
}

export interface ExecutionTransaction {
  /** Claims the next due message, skipping rows locked by other workers. */
  claimNextDue(now: Date): Promise<OutboxMessage | undefined>;
  getFollowerTrade(id: string): Promise<FollowerTrade | undefined>;
  lockFollower(followerId: string): Promise<FollowerRecord | undefined>;
  saveFollowerBalances(follower: Follower, now: Date): Promise<void>;
  /** Conditional `pending -> status` transition; resolves false if the row was not pending. */
  settleFollowerTrade(id: string, status: FollowerTradeStatus, now: Date): Promise<boolean>;
  completeMessage(id: string, now: Date): Promise<void>;
  rescheduleMessage(id: string, attempts: number, availableAt: Date, error: string): Promise<void>;
}

export type ExecutionUnitOfWork = TransactionRunner<ExecutionTransaction>;

export type ExecutionResult =
  { readonly status: 'executed' } | { readonly status: 'failed'; readonly error: string };

/** Downstream broker. Must be idempotent on `entry.id`. */
export interface ExecutionGateway {
  execute(entry: FollowerTrade): Promise<ExecutionResult>;
}

export interface ReconciliationRepository {
  loadSnapshots(): Promise<readonly FollowerLedgerSnapshot[]>;
  countStuckPending(olderThan: Date): Promise<number>;
  /** Makes stuck pending entries due again (and recreates missing outbox rows). Idempotent. */
  requeueStuckPending(olderThan: Date, now: Date): Promise<number>;
}
