import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { FollowerTradeStatus } from '@copy-trade/domain';

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

export interface Database {
  followers: FollowersTable;
  follower_trades: FollowerTradesTable;
  outbox: OutboxTable;
}

export type FollowerRow = Selectable<FollowersTable>;
export type FollowerTradeRow = Selectable<FollowerTradesTable>;
export type NewFollowerTradeRow = Insertable<FollowerTradesTable>;
export type OutboxRow = Selectable<OutboxTable>;
