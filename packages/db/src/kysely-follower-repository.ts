import type { FollowerRecord, FollowerRepository, FollowerView } from '@copy-trade/application';
import type { FollowerTrade } from '@copy-trade/domain';
import type { Kysely } from 'kysely';
import { toFollowerRecord, toFollowerTrade } from './mappers';
import type { Database, FollowerRow } from './schema';

export class KyselyFollowerRepository implements FollowerRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async #views(rows: readonly FollowerRow[]): Promise<FollowerView[]> {
    if (rows.length === 0) return [];
    const subscriptions = await this.#db
      .selectFrom('follower_subscriptions')
      .select(['follower_id', 'trader_id'])
      .where(
        'follower_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('created_at')
      .orderBy('trader_id')
      .execute();
    return rows.map((row) => ({
      ...toFollowerRecord(row),
      traderIds: subscriptions.filter((s) => s.follower_id === row.id).map((s) => s.trader_id),
    }));
  }

  async #view(row: FollowerRow | undefined): Promise<FollowerView | undefined> {
    if (row === undefined) return undefined;
    const [view] = await this.#views([row]);
    return view;
  }

  /** Follower and subscriptions are inserted in one transaction. */
  async create(record: FollowerRecord, traderIds: readonly string[]): Promise<FollowerView> {
    const row = await this.#db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('followers')
        .values({
          id: record.id,
          balance: record.balance,
          remaining_allocation: record.remainingAllocation,
          opening_balance: record.openingBalance,
          opening_allocation: record.openingAllocation,
          copying_enabled: record.copyingEnabled,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (traderIds.length > 0) {
        await trx
          .insertInto('follower_subscriptions')
          .values(
            traderIds.map((traderId) => ({
              follower_id: record.id,
              trader_id: traderId,
              created_at: record.createdAt,
            })),
          )
          .execute();
      }
      return inserted;
    });
    return { ...toFollowerRecord(row), traderIds: [...traderIds] };
  }

  async findById(id: string): Promise<FollowerView | undefined> {
    const row = await this.#db
      .selectFrom('followers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return this.#view(row);
  }

  async list(limit: number): Promise<readonly FollowerView[]> {
    const rows = await this.#db
      .selectFrom('followers')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(limit)
      .execute();
    return this.#views(rows);
  }

  async setCopyingEnabled(
    id: string,
    enabled: boolean,
    now: Date,
  ): Promise<FollowerView | undefined> {
    const row = await this.#db
      .updateTable('followers')
      .set({ copying_enabled: enabled, updated_at: now })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return this.#view(row);
  }

  async listTrades(followerId: string, limit: number): Promise<readonly FollowerTrade[]> {
    const rows = await this.#db
      .selectFrom('follower_trades')
      .selectAll()
      .where('follower_id', '=', followerId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toFollowerTrade);
  }
}
