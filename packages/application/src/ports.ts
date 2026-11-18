import type {
  Follower,
  FollowerLedgerSnapshot,
  FollowerTrade,
  FollowerTradeStatus,
  MinorUnits,
  RejectionReason,
  Trade,
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

/** Follower as shown to clients: the record plus the traders it copies. */
export interface FollowerView extends FollowerRecord {
  readonly traderIds: readonly string[];
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
  /** Inbox lookup for the idempotent consumer. */
  findProcessedEvent(eventId: string): Promise<ProcessedEvent | undefined>;
  /** Inserts the inbox row; resolves false when the event id was recorded concurrently. */
  recordProcessedEvent(record: ProcessedEvent): Promise<boolean>;
}

export type ProcessedOutcome = 'copied' | 'duplicate' | 'rejected' | 'idempotency_key_conflict';

export interface MessageSource {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

/** Inbox row: the stable outcome of one consumed event, written in the copy transaction. */
export interface ProcessedEvent {
  readonly eventId: string;
  readonly tradeId: string;
  readonly followerId: string;
  readonly outcome: ProcessedOutcome;
  readonly reason: RejectionReason | null;
  readonly followerTradeId: string | null;
  readonly handledBy: string;
  readonly source: MessageSource | null;
  readonly processedAt: Date;
}

/** One copy request for one follower, fanned out from an opened trade. */
export interface TradeOpenedEvent {
  readonly eventId: string;
  readonly type: 'TradeOpened';
  readonly version: 1;
  readonly occurredAt: string;
  readonly trade: Trade;
  readonly followerId: string;
}

export interface TradeRecord extends Trade {
  readonly createdAt: Date;
}

export interface OutboxEvent {
  readonly id: string;
  readonly eventId: string;
  readonly topic: string;
  /** Partition key: the follower id, so one follower's requests stay ordered. */
  readonly key: string;
  readonly tradeId: string;
  readonly payload: TradeOpenedEvent;
  readonly attempts: number;
  readonly availableAt: Date;
}

export interface TradeTransaction {
  /** Inserts the trade; resolves `undefined` when the id already exists. */
  insertTrade(trade: TradeRecord): Promise<TradeRecord | undefined>;
  findTrade(id: string): Promise<TradeRecord | undefined>;
  /** Followers subscribed to the trader with copying enabled (the trader itself excluded). */
  findEligibleSubscribers(traderId: string): Promise<readonly string[]>;
  enqueueEvent(event: OutboxEvent): Promise<void>;
  /** The first outbox row of every distinct event id fanned out for the trade. */
  listTradeEvents(tradeId: string): Promise<readonly OutboxEvent[]>;
}

export type TradeUnitOfWork = TransactionRunner<TradeTransaction>;

export interface EventRelayTransaction {
  /** Claims due unpublished events, skipping rows locked by other relays. */
  claimDueEvents(now: Date, limit: number): Promise<readonly OutboxEvent[]>;
  markPublished(ids: readonly string[], now: Date): Promise<void>;
  rescheduleEvent(id: string, attempts: number, availableAt: Date, error: string): Promise<void>;
}

export type EventRelayUnitOfWork = TransactionRunner<EventRelayTransaction>;

/** Message bus producer. Delivery is at-least-once; consumers dedupe on `eventId`. */
export interface EventPublisher {
  publish(events: readonly OutboxEvent[]): Promise<void>;
}

export interface FollowerRequestView {
  readonly eventId: string;
  readonly followerId: string;
  readonly publishedAt: Date | null;
  readonly processed: ProcessedEvent | null;
}

export interface TradeView {
  readonly trade: TradeRecord;
  readonly requests: readonly FollowerRequestView[];
}

export interface TradeReadRepository {
  findTradeView(id: string): Promise<TradeView | undefined>;
  listTradeViews(limit: number): Promise<readonly TradeView[]>;
}

export interface TransactionRunner<Tx> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export type CopyTradeUnitOfWork = TransactionRunner<CopyTradeTransaction>;

export interface FollowerRepository {
  create(record: FollowerRecord, traderIds: readonly string[]): Promise<FollowerView>;
  findById(id: string): Promise<FollowerView | undefined>;
  list(limit: number): Promise<readonly FollowerView[]>;
  setCopyingEnabled(id: string, enabled: boolean, now: Date): Promise<FollowerView | undefined>;
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
