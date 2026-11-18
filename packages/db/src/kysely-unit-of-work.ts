import type {
  CopyTradeTransaction,
  CopyTradeUnitOfWork,
  EventRelayTransaction,
  EventRelayUnitOfWork,
  ExecutionTransaction,
  ExecutionUnitOfWork,
  TradeRecord,
  TradeTransaction,
  TradeUnitOfWork,
} from '@copy-trade/application';
import type { Follower } from '@copy-trade/domain';
import type { Kysely, Transaction } from 'kysely';
import { toApplicationError } from './errors';
import {
  toFollowerRecord,
  toFollowerTrade,
  toFollowerTradeRow,
  toOutboxEvent,
  toProcessedEvent,
  toProcessedEventRow,
} from './mappers';
import type { Database, TradeRow } from './schema';

export interface UnitOfWorkOptions {
  /**
   * `for-update` (production) takes an exclusive row lock on the follower so concurrent
   * copies for the same follower serialize across connections, processes and hosts.
   * `none` exists only as the negative control proving the concurrency tests detect races.
   */
  readonly followerLocking: 'for-update' | 'none';
}

type Tx = Transaction<Database>;

const toTradeRecord = (row: TradeRow): TradeRecord => ({
  id: row.id,
  traderId: row.trader_id,
  amount: row.amount,
  createdAt: row.created_at,
});
type AnyTransaction = CopyTradeTransaction &
  ExecutionTransaction &
  TradeTransaction &
  EventRelayTransaction;

/**
 * Kysely adapter for the transactional ports. Each `transaction()` call is one Postgres
 * transaction (READ COMMITTED); transient SQLSTATEs are mapped to TransientTransactionError
 * so the application layer can retry the whole unit of work.
 */
export class KyselyUnitOfWork
  implements CopyTradeUnitOfWork, ExecutionUnitOfWork, TradeUnitOfWork, EventRelayUnitOfWork
{
  readonly #db: Kysely<Database>;
  readonly #options: UnitOfWorkOptions;

  constructor(
    db: Kysely<Database>,
    options: UnitOfWorkOptions = { followerLocking: 'for-update' },
  ) {
    this.#db = db;
    this.#options = options;
  }

  async transaction<T>(work: (tx: AnyTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.#db.transaction().execute((trx) => work(this.#bind(trx)));
    } catch (error) {
      throw toApplicationError(error);
    }
  }

  #bind(trx: Tx): AnyTransaction {
    const lockFollower = async (followerId: string) => {
      const query = trx.selectFrom('followers').selectAll().where('id', '=', followerId);
      const row = await (
        this.#options.followerLocking === 'for-update' ? query.forUpdate() : query
      ).executeTakeFirst();
      return row && toFollowerRecord(row);
    };

    const saveFollowerBalances = async (follower: Follower, now: Date) => {
      await trx
        .updateTable('followers')
        .set({
          balance: follower.balance,
          remaining_allocation: follower.remainingAllocation,
          updated_at: now,
        })
        .where('id', '=', follower.id)
        .executeTakeFirstOrThrow();
    };

    return {
      lockFollower,
      saveFollowerBalances,

      async findFollowerTrade(tradeId, followerId) {
        const row = await trx
          .selectFrom('follower_trades')
          .selectAll()
          .where('trade_id', '=', tradeId)
          .where('follower_id', '=', followerId)
          .executeTakeFirst();
        return row && toFollowerTrade(row);
      },

      async findFollowerTradeByIdempotencyKey(key) {
        const row = await trx
          .selectFrom('follower_trades')
          .selectAll()
          .where('idempotency_key', '=', key)
          .executeTakeFirst();
        return row && toFollowerTrade(row);
      },

      async insertFollowerTrade(entry) {
        const row = await trx
          .insertInto('follower_trades')
          .values(toFollowerTradeRow(entry))
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .executeTakeFirst();
        return row && toFollowerTrade(row);
      },

      async enqueueExecution(message) {
        await trx
          .insertInto('outbox')
          .values({
            id: message.id,
            follower_trade_id: message.followerTradeId,
            attempts: message.attempts,
            available_at: message.availableAt,
            created_at: message.availableAt,
          })
          .execute();
      },

      async claimNextDue(now) {
        const row = await trx
          .selectFrom('outbox')
          .select(['id', 'follower_trade_id', 'attempts', 'available_at'])
          .where('processed_at', 'is', null)
          .where('available_at', '<=', now)
          .orderBy('available_at')
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        return (
          row && {
            id: row.id,
            followerTradeId: row.follower_trade_id,
            attempts: row.attempts,
            availableAt: row.available_at,
          }
        );
      },

      async getFollowerTrade(id) {
        const row = await trx
          .selectFrom('follower_trades')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        return row && toFollowerTrade(row);
      },

      async settleFollowerTrade(id, status, now) {
        const result = await trx
          .updateTable('follower_trades')
          .set({ status, updated_at: now })
          .where('id', '=', id)
          .where('status', '=', 'pending')
          .executeTakeFirst();
        return result.numUpdatedRows === 1n;
      },

      async completeMessage(id, now) {
        await trx.updateTable('outbox').set({ processed_at: now }).where('id', '=', id).execute();
      },

      async rescheduleMessage(id, attempts, availableAt, error) {
        await trx
          .updateTable('outbox')
          .set({ attempts, available_at: availableAt, last_error: error })
          .where('id', '=', id)
          .execute();
      },

      async findProcessedEvent(eventId) {
        const row = await trx
          .selectFrom('processed_events')
          .selectAll()
          .where('event_id', '=', eventId)
          .executeTakeFirst();
        return row && toProcessedEvent(row);
      },

      async recordProcessedEvent(record) {
        const row = await trx
          .insertInto('processed_events')
          .values(toProcessedEventRow(record))
          .onConflict((oc) => oc.column('event_id').doNothing())
          .returning('event_id')
          .executeTakeFirst();
        return row !== undefined;
      },

      async insertTrade(trade) {
        const row = await trx
          .insertInto('trades')
          .values({
            id: trade.id,
            trader_id: trade.traderId,
            amount: trade.amount,
            created_at: trade.createdAt,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returningAll()
          .executeTakeFirst();
        return row && toTradeRecord(row);
      },

      async findTrade(id) {
        const row = await trx
          .selectFrom('trades')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        return row && toTradeRecord(row);
      },

      async findEligibleSubscribers(traderId) {
        const rows = await trx
          .selectFrom('follower_subscriptions as s')
          .innerJoin('followers as f', 'f.id', 's.follower_id')
          .select('f.id')
          .where('s.trader_id', '=', traderId)
          .where('f.copying_enabled', '=', true)
          .where('f.id', '<>', traderId)
          .orderBy('f.created_at')
          .orderBy('f.id')
          .execute();
        return rows.map((r) => r.id);
      },

      async enqueueEvent(event) {
        await trx
          .insertInto('event_outbox')
          .values({
            id: event.id,
            event_id: event.eventId,
            topic: event.topic,
            message_key: event.key,
            trade_id: event.tradeId,
            payload: JSON.stringify(event.payload),
            attempts: event.attempts,
            available_at: event.availableAt,
            created_at: event.availableAt,
          })
          .execute();
      },

      async listTradeEvents(tradeId) {
        const rows = await trx
          .selectFrom('event_outbox')
          .selectAll()
          .distinctOn('event_id')
          .where('trade_id', '=', tradeId)
          .orderBy('event_id')
          .orderBy('created_at')
          .orderBy('id')
          .execute();
        return rows
          .map(toOutboxEvent)
          .sort(
            (a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.id.localeCompare(b.id),
          );
      },

      async claimDueEvents(now, limit) {
        const rows = await trx
          .selectFrom('event_outbox')
          .selectAll()
          .where('published_at', 'is', null)
          .where('available_at', '<=', now)
          .orderBy('available_at')
          .orderBy('id')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        return rows.map(toOutboxEvent);
      },

      async markPublished(ids, now) {
        if (ids.length === 0) return;
        await trx
          .updateTable('event_outbox')
          .set({ published_at: now })
          .where('id', 'in', [...ids])
          .execute();
      },

      async rescheduleEvent(id, attempts, availableAt, error) {
        await trx
          .updateTable('event_outbox')
          .set({ attempts, available_at: availableAt, last_error: error })
          .where('id', '=', id)
          .execute();
      },
    };
  }
}
