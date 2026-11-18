import type { ReconciliationRepository } from '@copy-trade/application';
import type { FollowerLedgerSnapshot } from '@copy-trade/domain';
import { sql, type Kysely } from 'kysely';
import type { Database } from './schema';

export class KyselyReconciliationRepository implements ReconciliationRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /** One statement, so balances and ledger sums come from the same MVCC snapshot. */
  async loadSnapshots(): Promise<readonly FollowerLedgerSnapshot[]> {
    const rows = await this.#db
      .selectFrom('followers as f')
      .select((eb) => [
        'f.id',
        'f.opening_balance',
        'f.opening_allocation',
        'f.balance',
        'f.remaining_allocation',
        eb
          .selectFrom('follower_trades as ft')
          .select(sql<string>`coalesce(sum(ft.amount), 0)`.as('held'))
          .whereRef('ft.follower_id', '=', 'f.id')
          .where('ft.status', '<>', 'failed')
          .as('held_amount'),
        eb
          .selectFrom(
            eb
              .selectFrom('follower_trades as d')
              .select('d.trade_id')
              .whereRef('d.follower_id', '=', 'f.id')
              .groupBy('d.trade_id')
              .having(sql`count(*)`, '>', 1)
              .as('dups'),
          )
          .select(sql<string>`count(*)`.as('n'))
          .as('duplicate_key_count'),
      ])
      .orderBy('f.id')
      .execute();

    return rows.map((r) => ({
      followerId: r.id,
      openingBalance: r.opening_balance,
      openingAllocation: r.opening_allocation,
      balance: r.balance,
      remainingAllocation: r.remaining_allocation,
      heldAmount: Number(r.held_amount ?? 0),
      duplicateKeyCount: Number(r.duplicate_key_count ?? 0),
    }));
  }

  async countStuckPending(olderThan: Date): Promise<number> {
    const row = await this.#db
      .selectFrom('follower_trades')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', '=', 'pending')
      .where('created_at', '<', olderThan)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async requeueStuckPending(olderThan: Date, now: Date): Promise<number> {
    const result = await this.#db
      .insertInto('outbox')
      .columns(['id', 'follower_trade_id', 'attempts', 'available_at', 'created_at'])
      .expression((eb) =>
        eb
          .selectFrom('follower_trades as ft')
          .select([
            sql<string>`'redrive-' || ft.id`.as('id'),
            'ft.id as follower_trade_id',
            sql<number>`0`.as('attempts'),
            sql<Date>`${now}::timestamptz`.as('available_at'),
            sql<Date>`${now}::timestamptz`.as('created_at'),
          ])
          .where('ft.status', '=', 'pending')
          .where('ft.created_at', '<', olderThan),
      )
      .onConflict((oc) =>
        oc.column('follower_trade_id').doUpdateSet({ available_at: now, processed_at: null }),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
}
