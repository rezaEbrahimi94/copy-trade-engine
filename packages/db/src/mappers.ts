import type { FollowerRecord } from '@copy-trade/application';
import type { FollowerTrade } from '@copy-trade/domain';
import type { FollowerRow, FollowerTradeRow, NewFollowerTradeRow } from './schema';

export const toFollowerRecord = (row: FollowerRow): FollowerRecord => ({
  id: row.id,
  balance: row.balance,
  remainingAllocation: row.remaining_allocation,
  openingBalance: row.opening_balance,
  openingAllocation: row.opening_allocation,
  copyingEnabled: row.copying_enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toFollowerTrade = (row: FollowerTradeRow): FollowerTrade => ({
  id: row.id,
  tradeId: row.trade_id,
  traderId: row.trader_id,
  followerId: row.follower_id,
  amount: row.amount,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toFollowerTradeRow = (entry: FollowerTrade): NewFollowerTradeRow => ({
  id: entry.id,
  trade_id: entry.tradeId,
  trader_id: entry.traderId,
  follower_id: entry.followerId,
  amount: entry.amount,
  status: entry.status,
  idempotency_key: entry.idempotencyKey,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
});
