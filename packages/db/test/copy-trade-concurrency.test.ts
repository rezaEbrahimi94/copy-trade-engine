import type { CopyTradeResult } from '@copy-trade/application';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src';
import { insertFollower, services, startPostgres, type TestDatabase } from './support/postgres';

let pg: TestDatabase;
let db: Kysely<Database>;

beforeAll(async () => {
  pg = await startPostgres();
  db = pg.connect(60, 'concurrency-test');
});
afterAll(() => pg.stop());
beforeEach(() => pg.reset());

const tally = (results: readonly CopyTradeResult[]) =>
  results.reduce<Record<string, number>>((acc, r) => {
    const key = r.outcome === 'rejected' ? `rejected:${r.reason}` : r.outcome;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const follower = (id: string) =>
  db.selectFrom('followers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const ledgerRows = (followerId: string) =>
  db.selectFrom('follower_trades').selectAll().where('follower_id', '=', followerId).execute();

async function connectionsUsed(): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'concurrency-test'
  `.execute(db);
  return Number(rows[0]?.n ?? 0);
}

describe('copy trade on real Postgres (SELECT ... FOR UPDATE)', () => {
  it('scenario 1: 10,000 / 2,000 follower copies a 700 trade', async () => {
    const { copyTrades, reconciliation } = services(db);
    await insertFollower(db, 'f1', 10_000, 2_000);

    const result = await copyTrades.processCopyTrade({
      trade: { id: 't1', traderId: 'trader', amount: 700 },
      followerId: 'f1',
    });

    expect(result.outcome).toBe('copied');
    expect(await follower('f1')).toMatchObject({ balance: 9_300, remaining_allocation: 1_300 });
    expect(await ledgerRows('f1')).toHaveLength(1);
    expect(await db.selectFrom('outbox').selectAll().execute()).toHaveLength(1);
    expect((await reconciliation.run()).summary.driftedFollowers).toBe(0);
  });

  it('scenario 2: same trade twice, sequentially -> one row, duplicate returns original', async () => {
    const { copyTrades } = services(db);
    await insertFollower(db, 'f1', 10_000, 2_000);
    const command = { trade: { id: 't1', traderId: 'trader', amount: 700 }, followerId: 'f1' };

    const first = await copyTrades.processCopyTrade(command);
    const second = await copyTrades.processCopyTrade(command);

    expect(first.outcome).toBe('copied');
    expect(second.outcome).toBe('duplicate');
    expect(second.outcome === 'duplicate' && second.followerTrade).toEqual(
      first.outcome === 'copied' && first.followerTrade,
    );
    expect(await follower('f1')).toMatchObject({ balance: 9_300 });
  });

  it('50 concurrent identical trades over separate pool connections -> exactly 1 row', async () => {
    const { copyTrades, reconciliation } = services(db);
    await insertFollower(db, 'f1', 10_000, 2_000);
    const command = { trade: { id: 't1', traderId: 'trader', amount: 700 }, followerId: 'f1' };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => copyTrades.processCopyTrade(command)),
    );

    expect(tally(results)).toEqual({ copied: 1, duplicate: 49 });
    expect(await ledgerRows('f1')).toHaveLength(1);
    expect(await follower('f1')).toMatchObject({ balance: 9_300, remaining_allocation: 1_300 });
    expect(await connectionsUsed()).toBeGreaterThan(10);
    expect((await reconciliation.run()).summary.driftedFollowers).toBe(0);
  });

  it('scenario 3: 2 concurrent 700 trades on 1,000 / 1,000 -> exactly 1 success', async () => {
    const { copyTrades } = services(db);
    await insertFollower(db, 'f1', 1_000, 1_000);

    const results = await Promise.all(
      ['a', 'b'].map((id) =>
        copyTrades.processCopyTrade({
          trade: { id, traderId: 'trader', amount: 700 },
          followerId: 'f1',
        }),
      ),
    );

    expect(tally(results)).toEqual({ copied: 1, 'rejected:INSUFFICIENT_BALANCE': 1 });
    expect(await follower('f1')).toMatchObject({ balance: 300, remaining_allocation: 300 });
  });

  it('N=40 concurrent different 700 trades on 1,000 / 1,000 -> exactly 1 success, never negative', async () => {
    const { copyTrades, reconciliation } = services(db);
    await insertFollower(db, 'f1', 1_000, 1_000);

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        copyTrades.processCopyTrade({
          trade: { id: `t${String(i)}`, traderId: 'trader', amount: 700 },
          followerId: 'f1',
        }),
      ),
    );

    expect(tally(results)).toEqual({ copied: 1, 'rejected:INSUFFICIENT_BALANCE': 39 });
    expect(await follower('f1')).toMatchObject({ balance: 300, remaining_allocation: 300 });
    expect(await ledgerRows('f1')).toHaveLength(1);
    expect((await reconciliation.run()).summary.driftedFollowers).toBe(0);
  });

  it('mixed storm: 200 requests (duplicates + distinct) across 5 followers keep every invariant', async () => {
    const { copyTrades, reconciliation } = services(db);
    for (let f = 0; f < 5; f++) await insertFollower(db, `f${String(f)}`, 5_000, 3_000);

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        copyTrades.processCopyTrade({
          trade: { id: `t${String(i % 20)}`, traderId: 'trader', amount: 100 + (i % 7) * 50 },
          followerId: `f${String(i % 5)}`,
        }),
      ),
    );

    const copied = results.filter((r) => r.outcome === 'copied').length;
    const rows = await db.selectFrom('follower_trades').select('id').execute();
    expect(rows).toHaveLength(copied);
    const negatives = await db
      .selectFrom('followers')
      .select('id')
      .where((eb) => eb.or([eb('balance', '<', 0), eb('remaining_allocation', '<', 0)]))
      .execute();
    expect(negatives).toEqual([]);
    const report = await reconciliation.run();
    expect(report.summary).toMatchObject({
      driftedFollowers: 0,
      duplicateKeys: 0,
      followersChecked: 5,
    });
  });

  it('Idempotency-Key: concurrent reuse across followers -> one copy, one conflict, no debit leak', async () => {
    const { copyTrades, reconciliation } = services(db);
    await insertFollower(db, 'f1', 1_000, 1_000);
    await insertFollower(db, 'f2', 1_000, 1_000);

    const results = await Promise.all(
      ['f1', 'f2'].map((followerId) =>
        copyTrades.processCopyTrade({
          trade: { id: 't1', traderId: 'trader', amount: 100 },
          followerId,
          idempotencyKey: 'same-key',
        }),
      ),
    );

    expect(tally(results)).toEqual({ copied: 1, idempotency_key_conflict: 1 });
    const balances = (await db.selectFrom('followers').select('balance').execute()).map(
      (r) => r.balance,
    );
    expect(balances.sort()).toEqual([1_000, 900].sort());
    expect((await reconciliation.run()).summary.driftedFollowers).toBe(0);
  });

  describe('NEGATIVE CONTROL: follower row lock removed', () => {
    it('the concurrency test detects lost updates (multiple successes, ledger drift)', async () => {
      const unsafe = services(db, { followerLocking: 'none' });
      let observed: Record<string, number> = {};
      let drifted = 0;
      let round = 0;

      // Races are probabilistic; retry rounds until the missing lock is exposed.
      for (; round < 20 && drifted === 0; round++) {
        await pg.reset();
        await insertFollower(db, 'f1', 1_000, 1_000);
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            unsafe.copyTrades.processCopyTrade({
              trade: { id: `t${String(i)}`, traderId: 'trader', amount: 700 },
              followerId: 'f1',
            }),
          ),
        );
        observed = tally(results);
        drifted = (await unsafe.reconciliation.run()).summary.driftedFollowers;
      }

      process.stdout.write(
        `[negative-control] rounds=${String(round)} outcomes=${JSON.stringify(observed)}\n`,
      );
      // Without FOR UPDATE, more than one 700 trade is accepted against 1,000: exactly the
      // bug the safe tests rule out. Reconciliation catches it as drift.
      expect(observed['copied']).toBeGreaterThan(1);
      expect(drifted).toBe(1);
    });

    it('the unique (trade_id, follower_id) constraint still prevents duplicate rows', async () => {
      const unsafe = services(db, { followerLocking: 'none' });
      await insertFollower(db, 'f1', 10_000, 10_000);

      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          unsafe.copyTrades.processCopyTrade({
            trade: { id: 't1', traderId: 'trader', amount: 100 },
            followerId: 'f1',
          }),
        ),
      );

      expect(results.filter((r) => r.outcome === 'copied')).toHaveLength(1);
      expect(await ledgerRows('f1')).toHaveLength(1);
      expect(unsafe.retries).toContain('ledger_key_conflict');
    });
  });
});
