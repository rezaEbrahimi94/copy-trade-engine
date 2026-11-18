import { TransientTransactionError } from '@copy-trade/application';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KyselyUnitOfWork,
  parseSafeInteger,
  pgErrorCode,
  toApplicationError,
  type Database,
} from '../src';
import { insertFollower, startPostgres, type TestDatabase } from './support/postgres';

let pg: TestDatabase;
let db: Kysely<Database>;

beforeAll(async () => {
  pg = await startPostgres();
  db = pg.connect(10);
});
afterAll(() => pg.stop());
beforeEach(() => pg.reset());

const codeOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    return pgErrorCode(error);
  }
};

const insertTrade = (id: string, tradeId: string, amount = 100, key: string | null = null) =>
  db
    .insertInto('follower_trades')
    .values({
      id,
      trade_id: tradeId,
      trader_id: 'trader',
      follower_id: 'f1',
      amount,
      status: 'pending',
      idempotency_key: key,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

describe('database constraints (last line of defence)', () => {
  beforeEach(() => insertFollower(db, 'f1', 1_000, 1_000));

  it('CHECK balance >= 0 rejects a negative balance (23514)', async () => {
    expect(
      await codeOf(
        db.updateTable('followers').set({ balance: -1 }).where('id', '=', 'f1').execute(),
      ),
    ).toBe('23514');
  });

  it('CHECK remaining_allocation >= 0 rejects a negative allocation (23514)', async () => {
    expect(
      await codeOf(
        db
          .updateTable('followers')
          .set({ remaining_allocation: -1 })
          .where('id', '=', 'f1')
          .execute(),
      ),
    ).toBe('23514');
  });

  it('CHECK amount > 0 on the ledger (23514)', async () => {
    expect(await codeOf(insertTrade('x', 't', 0))).toBe('23514');
  });

  it('UNIQUE (trade_id, follower_id) rejects a second row for the same key (23505)', async () => {
    await insertTrade('a', 't1');
    expect(await codeOf(insertTrade('b', 't1'))).toBe('23505');
  });

  it('UNIQUE idempotency_key (23505)', async () => {
    await insertTrade('a', 't1', 100, 'k');
    expect(await codeOf(insertTrade('b', 't2', 100, 'k'))).toBe('23505');
  });

  it('ON CONFLICT DO NOTHING RETURNING yields no row for an existing key', async () => {
    await insertTrade('a', 't1');
    const uow = new KyselyUnitOfWork(db);
    const inserted = await uow.transaction((tx) =>
      tx.insertFollowerTrade({
        id: 'b',
        tradeId: 't1',
        traderId: 'trader',
        followerId: 'f1',
        amount: 100,
        status: 'pending',
        idempotencyKey: null,
        handledBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    expect(inserted).toBeUndefined();
  });

  describe('append-only ledger trigger', () => {
    beforeEach(() => insertTrade('a', 't1'));

    it('blocks DELETE', async () => {
      expect(await codeOf(db.deleteFrom('follower_trades').execute())).toBe('23001');
    });

    it('blocks changing the amount or key columns', async () => {
      expect(
        await codeOf(sql`UPDATE follower_trades SET amount = 1 WHERE id = 'a'`.execute(db)),
      ).toBe('23001');
      expect(
        await codeOf(sql`UPDATE follower_trades SET trade_id = 'z' WHERE id = 'a'`.execute(db)),
      ).toBe('23001');
    });

    it('allows pending -> executed but not executed -> pending', async () => {
      await db
        .updateTable('follower_trades')
        .set({ status: 'executed' })
        .where('id', '=', 'a')
        .execute();
      expect(
        await codeOf(
          db
            .updateTable('follower_trades')
            .set({ status: 'pending' })
            .where('id', '=', 'a')
            .execute(),
        ),
      ).toBe('23001');
    });

    it('rejects unknown statuses (23514)', async () => {
      expect(
        await codeOf(sql`UPDATE follower_trades SET status = 'lost' WHERE id = 'a'`.execute(db)),
      ).toBe('23514');
    });
  });

  it('FK prevents ledger rows for unknown followers (23503)', async () => {
    expect(
      await codeOf(
        db
          .insertInto('follower_trades')
          .values({
            id: 'x',
            trade_id: 't',
            trader_id: 'tr',
            follower_id: 'missing',
            amount: 1,
            status: 'pending',
            idempotency_key: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute(),
      ),
    ).toBe('23503');
  });
});

describe('transient error classification', () => {
  it('a real deadlock (40P01) is mapped to TransientTransactionError by the unit of work', async () => {
    await insertFollower(db, 'a', 1, 1);
    await insertFollower(db, 'b', 1, 1);
    const uow = new KyselyUnitOfWork(db);
    let bothLockedFirst!: () => void;
    let count = 0;
    const barrier = new Promise<void>((resolve) => (bothLockedFirst = resolve));
    const arrive = async () => {
      count += 1;
      if (count === 2) bothLockedFirst();
      await barrier;
    };

    const crossLock = (first: string, second: string) =>
      uow.transaction(async (tx) => {
        await tx.lockFollower(first);
        await arrive();
        await tx.lockFollower(second);
      });

    const results = await Promise.allSettled([crossLock('a', 'b'), crossLock('b', 'a')]);
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(rejected).toHaveLength(1);
    const reason: unknown = rejected[0]?.reason;
    expect(reason).toBeInstanceOf(TransientTransactionError);
    expect((reason as TransientTransactionError).code).toBe('40P01');
  });

  it('a serialization failure (40001) is mapped too; other errors pass through', async () => {
    await insertFollower(db, 'a', 1, 1);
    const serializable = () =>
      db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (trx) => {
          const row = await trx
            .selectFrom('followers')
            .select('balance')
            .where('id', '=', 'a')
            .executeTakeFirstOrThrow();
          await new Promise((r) => setTimeout(r, 50));
          await trx
            .updateTable('followers')
            .set({ balance: row.balance + 1 })
            .where('id', '=', 'a')
            .execute();
        });
    const results = await Promise.allSettled([serializable(), serializable()]);
    const failure = results.find((r) => r.status === 'rejected');
    const mapped = toApplicationError(failure?.status === 'rejected' ? failure.reason : undefined);
    expect(mapped).toBeInstanceOf(TransientTransactionError);
    expect((mapped as TransientTransactionError).code).toBe('40001');

    const other = new Error('x');
    expect(toApplicationError(other)).toBe(other);
    expect(toApplicationError(Object.assign(new Error('y'), { code: 23505 }))).toBeInstanceOf(
      Error,
    );
    expect(pgErrorCode(null)).toBeUndefined();
  });

  it('BIGINT values beyond Number.MAX_SAFE_INTEGER are refused, never rounded', async () => {
    expect(parseSafeInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseSafeInteger('9007199254740993')).toThrow(RangeError);
    await sql`INSERT INTO followers VALUES ('big', 9007199254740993, 0, 0, 0, true, now(), now())`.execute(
      db,
    );
    await expect(
      db.selectFrom('followers').selectAll().where('id', '=', 'big').execute(),
    ).rejects.toThrow(RangeError);
  });
});
