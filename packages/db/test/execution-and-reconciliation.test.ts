import { ExecutionService, type ExecutionResult } from '@copy-trade/application';
import { ScriptedGateway } from '@copy-trade/application/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KyselyFollowerRepository, KyselyUnitOfWork, type Database } from '../src';
import {
  insertFollower,
  services,
  startPostgres,
  systemClock,
  type TestDatabase,
} from './support/postgres';

let pg: TestDatabase;
let db: Kysely<Database>;

beforeAll(async () => {
  pg = await startPostgres();
  db = pg.connect(20);
});
afterAll(() => pg.stop());
beforeEach(() => pg.reset());

const relay = (
  script: () => ExecutionResult,
  gateway = new ScriptedGateway(script),
  maxAttempts = 1,
) => ({
  gateway,
  service: new ExecutionService({
    unitOfWork: new KyselyUnitOfWork(db),
    gateway,
    clock: systemClock,
    maxAttempts,
    retryDelayMs: 0,
  }),
});

async function seed(trades: number, amount = 100) {
  const { copyTrades } = services(db);
  await insertFollower(db, 'f1', 10_000, 10_000);
  for (let i = 0; i < trades; i++) {
    await copyTrades.processCopyTrade({
      trade: { id: `t${String(i)}`, traderId: 'trader', amount },
      followerId: 'f1',
    });
  }
}

describe('outbox relay on Postgres', () => {
  it('executes pending entries exactly once even with 4 concurrent relays (SKIP LOCKED)', async () => {
    await seed(20);
    const gateway = new ScriptedGateway(() => ({ status: 'executed' }));
    const relays = Array.from({ length: 4 }, () => relay(() => ({ status: 'executed' }), gateway));

    const steps = (await Promise.all(relays.map((r) => r.service.drain(100)))).flat();

    expect(steps).toHaveLength(20);
    expect(gateway.calls).toHaveLength(20);
    expect(new Set(gateway.calls.map((c) => c.id)).size).toBe(20);
    const statuses = await db.selectFrom('follower_trades').select('status').distinct().execute();
    expect(statuses).toEqual([{ status: 'executed' }]);
  });

  it('compensates failed executions: status failed + refund, idempotently, ledger still reconciles', async () => {
    await seed(3, 700);
    const { service } = relay(() => ({ status: 'failed', error: 'rejected by broker' }));
    const { reconciliation } = services(db);

    expect((await service.drain(10)).map((s) => s.kind)).toEqual([
      'compensated',
      'compensated',
      'compensated',
    ]);
    expect(await service.drain(10)).toEqual([]);

    const follower = await db.selectFrom('followers').selectAll().executeTakeFirstOrThrow();
    expect(follower).toMatchObject({ balance: 10_000, remaining_allocation: 10_000 });
    const report = await reconciliation.run();
    expect(report.summary.driftedFollowers).toBe(0);
  });

  it('reschedules with attempts and last_error before the final attempt', async () => {
    await seed(1);
    const { service } = relay(() => ({ status: 'failed', error: 'timeout' }), undefined, 3);
    expect((await service.processNext()).kind).toBe('rescheduled');
    const message = await db.selectFrom('outbox').selectAll().executeTakeFirstOrThrow();
    expect(message).toMatchObject({ attempts: 1, last_error: 'timeout', processed_at: null });
  });
});

describe('reconciliation on Postgres', () => {
  it('reports a consistent ledger', async () => {
    await seed(5);
    const { reconciliation } = services(db);
    const report = await reconciliation.run();
    expect(report.summary).toEqual({
      followersChecked: 1,
      driftedFollowers: 0,
      totalAbsoluteDrift: 0,
      duplicateKeys: 0,
    });
  });

  it('detects tampering (balance changed outside the ledger) and does not fix it', async () => {
    await seed(2);
    await db.updateTable('followers').set({ balance: 9_999 }).execute();
    const { reconciliation } = services(db);

    const report = await reconciliation.run();

    expect(report.drifted).toEqual([
      expect.objectContaining({
        followerId: 'f1',
        expectedBalance: 9_800,
        actualBalance: 9_999,
        balanceDrift: 199,
      }),
    ]);
    const after = await db.selectFrom('followers').select('balance').executeTakeFirstOrThrow();
    expect(after.balance).toBe(9_999);
  });

  it('detects duplicate keys if the unique constraint were ever dropped', async () => {
    await seed(1);
    await sql`ALTER TABLE follower_trades DROP CONSTRAINT follower_trades_trade_follower_key`.execute(
      db,
    );
    try {
      await sql`INSERT INTO follower_trades SELECT 'dup', trade_id, trader_id, follower_id, amount, status, NULL, created_at, updated_at FROM follower_trades`.execute(
        db,
      );
      const report = await services(db).reconciliation.run();
      expect(report.summary.duplicateKeys).toBe(1);
    } finally {
      await sql`TRUNCATE outbox, follower_trades, followers`.execute(db);
      await sql`ALTER TABLE follower_trades ADD CONSTRAINT follower_trades_trade_follower_key UNIQUE (trade_id, follower_id)`.execute(
        db,
      );
    }
  });

  it('counts stuck pending entries and re-drives them idempotently', async () => {
    await seed(2);
    await db.updateTable('outbox').set({ processed_at: new Date() }).execute();
    await db
      .deleteFrom('outbox')
      .where('id', 'in', db.selectFrom('outbox').select('id').limit(1))
      .execute();
    const { reconciliation } = services(db);
    const later = new Date(Date.now() + 120_000);
    const repo = (await import('../src')).KyselyReconciliationRepository;
    const repository = new repo(db);

    expect(await repository.countStuckPending(later)).toBe(2);
    expect(await repository.requeueStuckPending(later, later)).toBe(2);
    expect(await repository.requeueStuckPending(later, later)).toBe(2);
    const outbox = await db.selectFrom('outbox').selectAll().orderBy('id').execute();
    expect(outbox).toHaveLength(2);
    expect(outbox.every((m) => m.processed_at === null)).toBe(true);
    expect(outbox.some((m) => m.id.startsWith('redrive-'))).toBe(true);
    expect((await reconciliation.run()).stuckPending).toBe(0);
  });
});

describe('KyselyFollowerRepository', () => {
  it('creates, finds, lists, toggles and lists trades', async () => {
    const repo = new KyselyFollowerRepository(db);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const created = await repo.create({
      id: 'f9',
      balance: 5,
      remainingAllocation: 4,
      openingBalance: 5,
      openingAllocation: 4,
      copyingEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(created).toMatchObject({ id: 'f9', balance: 5, remainingAllocation: 4 });
    expect(await repo.findById('f9')).toEqual(created);
    expect(await repo.findById('nope')).toBeUndefined();
    expect(await repo.list(10)).toEqual([created]);
    expect(await repo.setCopyingEnabled('f9', false, now)).toMatchObject({ copyingEnabled: false });
    expect(await repo.setCopyingEnabled('nope', false, now)).toBeUndefined();
    expect(await repo.listTrades('f9', 10)).toEqual([]);
  });
});
