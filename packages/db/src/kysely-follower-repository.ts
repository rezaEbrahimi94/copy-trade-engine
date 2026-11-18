import type { FollowerRecord, FollowerRepository } from '@copy-trade/application';
import type { FollowerTrade } from '@copy-trade/domain';
import type { Kysely } from 'kysely';
import { toFollowerRecord, toFollowerTrade } from './mappers';
import type { Database } from './schema';

export class KyselyFollowerRepository implements FollowerRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async create(record: FollowerRecord): Promise<FollowerRecord> {
    const row = await this.#db
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
    return toFollowerRecord(row);
  }

  async findById(id: string): Promise<FollowerRecord | undefined> {
    const row = await this.#db
      .selectFrom('followers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toFollowerRecord(row);
  }

  async list(limit: number): Promise<readonly FollowerRecord[]> {
    const rows = await this.#db
      .selectFrom('followers')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(limit)
      .execute();
    return rows.map(toFollowerRecord);
  }

  async setCopyingEnabled(
    id: string,
    enabled: boolean,
    now: Date,
  ): Promise<FollowerRecord | undefined> {
    const row = await this.#db
      .updateTable('followers')
      .set({ copying_enabled: enabled, updated_at: now })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row && toFollowerRecord(row);
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
