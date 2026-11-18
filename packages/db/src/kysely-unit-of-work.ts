import type {
  CopyTradeTransaction,
  CopyTradeUnitOfWork,
  ExecutionTransaction,
  ExecutionUnitOfWork,
} from '@copy-trade/application';
import type { Follower } from '@copy-trade/domain';
import type { Kysely, Transaction } from 'kysely';
import { toApplicationError } from './errors';
import { toFollowerRecord, toFollowerTrade, toFollowerTradeRow } from './mappers';
import type { Database } from './schema';

export interface UnitOfWorkOptions {
  /**
   * `for-update` (production) takes an exclusive row lock on the follower so concurrent
   * copies for the same follower serialize across connections, processes and hosts.
   * `none` exists only as the negative control proving the concurrency tests detect races.
   */
  readonly followerLocking: 'for-update' | 'none';
}

type Tx = Transaction<Database>;

/**
 * Kysely adapter for the transactional ports. Each `transaction()` call is one Postgres
 * transaction (READ COMMITTED); transient SQLSTATEs are mapped to TransientTransactionError
 * so the application layer can retry the whole unit of work.
 */
export class KyselyUnitOfWork implements CopyTradeUnitOfWork, ExecutionUnitOfWork {
  readonly #db: Kysely<Database>;
  readonly #options: UnitOfWorkOptions;

  constructor(
    db: Kysely<Database>,
    options: UnitOfWorkOptions = { followerLocking: 'for-update' },
  ) {
    this.#db = db;
    this.#options = options;
  }

  async transaction<T>(
    work: (tx: CopyTradeTransaction & ExecutionTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#db.transaction().execute((trx) => work(this.#bind(trx)));
    } catch (error) {
      throw toApplicationError(error);
    }
  }

  #bind(trx: Tx): CopyTradeTransaction & ExecutionTransaction {
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
    };
  }
}
