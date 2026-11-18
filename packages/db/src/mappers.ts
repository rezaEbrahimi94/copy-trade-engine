import type { FollowerRecord, OutboxEvent, ProcessedEvent } from '@copy-trade/application';
import type { FollowerTrade } from '@copy-trade/domain';
import type {
  EventOutboxRow,
  FollowerRow,
  FollowerTradeRow,
  NewFollowerTradeRow,
  ProcessedEventRow,
} from './schema';

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
  handledBy: row.handled_by,
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
  handled_by: entry.handledBy,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
});

export const toOutboxEvent = (row: EventOutboxRow): OutboxEvent => ({
  id: row.id,
  eventId: row.event_id,
  topic: row.topic,
  key: row.message_key,
  tradeId: row.trade_id,
  payload: row.payload,
  attempts: row.attempts,
  availableAt: row.available_at,
});

export const toProcessedEvent = (row: ProcessedEventRow): ProcessedEvent => ({
  eventId: row.event_id,
  tradeId: row.trade_id,
  followerId: row.follower_id,
  outcome: row.outcome,
  reason: row.reason,
  followerTradeId: row.follower_trade_id,
  handledBy: row.handled_by,
  source:
    row.topic === null || row.partition === null || row.kafka_offset === null
      ? null
      : { topic: row.topic, partition: row.partition, offset: row.kafka_offset },
  processedAt: row.processed_at,
});

export const toProcessedEventRow = (record: ProcessedEvent): ProcessedEventRow => ({
  event_id: record.eventId,
  trade_id: record.tradeId,
  follower_id: record.followerId,
  outcome: record.outcome,
  reason: record.reason,
  follower_trade_id: record.followerTradeId,
  handled_by: record.handledBy,
  topic: record.source?.topic ?? null,
  partition: record.source?.partition ?? null,
  kafka_offset: record.source?.offset ?? null,
  processed_at: record.processedAt,
});
