import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { ProcessedOutcome, TradeOpenedEvent } from '@copy-trade/application';
import type { FollowerTradeStatus, RejectionReason } from '@copy-trade/domain';

/** BIGINT money columns; parsed to safe JS integers by the pool's type parser. */
type Money = ColumnType<number, number, number>;
type Timestamp = ColumnType<Date, Date, Date>;

export interface FollowersTable {
  id: string;
  balance: Money;
  remaining_allocation: Money;
  opening_balance: ColumnType<number, number, never>;
  opening_allocation: ColumnType<number, number, never>;
  copying_enabled: boolean;
  created_at: ColumnType<Date, Date, never>;
  updated_at: Timestamp;
}

export interface FollowerTradesTable {
  id: string;
  trade_id: ColumnType<string, string, never>;
  trader_id: ColumnType<string, string, never>;
  follower_id: ColumnType<string, string, never>;
  amount: ColumnType<number, number, never>;
  status: FollowerTradeStatus;
  idempotency_key: ColumnType<string | null, string | null, never>;
  handled_by: ColumnType<string | null, string | null, never>;
  created_at: ColumnType<Date, Date, never>;
  updated_at: Timestamp;
}

export interface OutboxTable {
  id: string;
  follower_trade_id: string;
  attempts: Generated<number>;
  available_at: Timestamp;
  processed_at: ColumnType<Date | null, Date | null, Date | null>;
  last_error: ColumnType<string | null, string | null, string | null>;
  created_at: ColumnType<Date, Date, never>;
}

export interface FollowerSubscriptionsTable {
  follower_id: string;
  trader_id: string;
  created_at: ColumnType<Date, Date, never>;
}

export interface TradesTable {
  id: string;
  trader_id: ColumnType<string, string, never>;
  amount: ColumnType<number, number, never>;
  created_at: ColumnType<Date, Date, never>;
}

export interface EventOutboxTable {
  id: string;
  event_id: string;
  topic: string;
  message_key: string;
  trade_id: string;
  payload: ColumnType<TradeOpenedEvent, string, never>;
  attempts: Generated<number>;
  available_at: Timestamp;
  published_at: ColumnType<Date | null, Date | null, Date | null>;
  last_error: ColumnType<string | null, string | null, string | null>;
  created_at: ColumnType<Date, Date, never>;
}

export interface ProcessedEventsTable {
  event_id: string;
  trade_id: string;
  follower_id: string;
  outcome: ProcessedOutcome;
  reason: RejectionReason | null;
  follower_trade_id: string | null;
  handled_by: string;
  topic: string | null;
  partition: number | null;
  kafka_offset: string | null;
  processed_at: Date;
}

export interface InstancesTable {
  id: string;
  kind: 'api' | 'worker';
  started_at: Date;
  last_seen_at: Date;
  stopped_at: Date | null;
  partitions: ColumnType<number[], number[] | undefined, number[]>;
}

export interface Database {
  followers: FollowersTable;
  follower_trades: FollowerTradesTable;
  outbox: OutboxTable;
  follower_subscriptions: FollowerSubscriptionsTable;
  trades: TradesTable;
  event_outbox: EventOutboxTable;
  processed_events: ProcessedEventsTable;
  instances: InstancesTable;
}

export type EventOutboxRow = Selectable<EventOutboxTable>;
export type ProcessedEventRow = Selectable<ProcessedEventsTable>;
export type TradeRow = Selectable<TradesTable>;
export type InstanceRow = Selectable<InstancesTable>;

export type FollowerRow = Selectable<FollowersTable>;
export type FollowerTradeRow = Selectable<FollowerTradesTable>;
export type NewFollowerTradeRow = Insertable<FollowerTradesTable>;
export type OutboxRow = Selectable<OutboxTable>;
