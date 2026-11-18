import { setTimeout as delay } from 'node:timers/promises';
import {
  EventRelayService,
  TradeService,
  type OutboxEvent,
  type ProcessRequestedEventCommand,
} from '@copy-trade/application';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KyselyInstanceRegistry,
  KyselyTradeReadRepository,
  KyselyUnitOfWork,
  type Database,
} from '../src';
import {
  ids,
  insertFollower,
  services,
  startPostgres,
  subscribe,
  systemClock,
  type TestDatabase,
} from './support/postgres';

let pg: TestDatabase;
let db: Kysely<Database>;

beforeAll(async () => {
  pg = await startPostgres();
  db = pg.connect(60, 'event-tables-test');
});
afterAll(() => pg.stop());
beforeEach(() => pg.reset());

const tradeService = () =>
  new TradeService({
    unitOfWork: new KyselyUnitOfWork(db),
    reads: new KyselyTradeReadRepository(db),
    clock: systemClock,
    ids,
    retry: { maxAttempts: 5, baseDelayMs: 1, sleep: () => delay(1), random: Math.random },
    requestedTopic: 'copy-trade.requested',
    listLimit: 50,
  });

const event = (overrides: Partial<ProcessRequestedEventCommand> = {}) => ({
  eventId: 'evt-1',
  trade: { id: 't1', traderId: 'trader', amount: 700 },
  followerId: 'f1',
  handledBy: 'worker-1',
  source: { topic: 'copy-trade.requested', partition: 3, offset: '17' },
  ...overrides,
});

describe('trade fan-out on Postgres', () => {
  it('stores the trade and one outbox event per eligible subscriber atomically', async () => {
    await insertFollower(db, 'f1', 1_000, 1_000);
    await insertFollower(db, 'f2', 1_000, 1_000);
    await insertFollower(db, 'off', 1_000, 1_000, false);
    await insertFollower(db, 'trader', 1_000, 1_000);
    for (const id of ['f1', 'f2', 'off', 'trader']) await subscribe(db, id, ['trader']);
    const service = tradeService();

    const opened = await service.openTrade({ id: 'T1', traderId: 'trader', amount: 700 });
    const again = await service.openTrade({ id: 'T1', traderId: 'trader', amount: 700 });
    const conflict = await service.openTrade({ id: 'T1', traderId: 'trader', amount: 1 });

    expect(opened).toMatchObject({ outcome: 'accepted', requestedFollowerIds: ['f1', 'f2'] });
    expect(again).toMatchObject({ outcome: 'duplicate', requestedFollowerIds: ['f1', 'f2'] });
    expect(conflict).toMatchObject({ outcome: 'trade_conflict' });
    const rows = await db.selectFrom('event_outbox').selectAll().orderBy('message_key').execute();
    expect(rows.map((r) => [r.message_key, r.payload.followerId, r.published_at])).toEqual([
      ['f1', 'f1', null],
      ['f2', 'f2', null],
    ]);
    expect(rows[0]?.payload).toMatchObject({ type: 'TradeOpened', trade: { amount: 700 } });
  });

  it('republish adds rows with the same event ids; the read model shows one request each', async () => {
    await insertFollower(db, 'f1', 1_000, 1_000);
    await subscribe(db, 'f1', ['trader']);
    const service = tradeService();
    await service.openTrade({ id: 'T1', traderId: 'trader', amount: 700 });

    expect(await service.republish('T1')).toBe(1);
    const rows = await db.selectFrom('event_outbox').select('event_id').execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(1);

    const view = await service.get('T1');
    expect(view?.requests).toHaveLength(1);
    expect(view?.requests[0]).toMatchObject({
      followerId: 'f1',
      publishedAt: null,
      processed: null,
    });
    expect(await service.get('missing')).toBeUndefined();
    expect((await service.list()).map((v) => v.trade.id)).toEqual(['T1']);
  });

  it('the trades table refuses non-positive amounts (CHECK 23514)', async () => {
    await expect(
      db
        .insertInto('trades')
        .values({ id: 'x', trader_id: 't', amount: 0, created_at: new Date() })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('idempotent consumer on Postgres', () => {
  it('a redelivered event id is applied once and keeps its first outcome', async () => {
    await insertFollower(db, 'f1', 10_000, 2_000);
    const { copyTrades } = services(db);

    const first = await copyTrades.processRequestedEvent(event());
    const again = await copyTrades.processRequestedEvent(event({ handledBy: 'worker-2' }));

    expect(first).toMatchObject({ redelivered: false, record: { outcome: 'copied' } });
    expect(again).toEqual({ redelivered: true, record: first.record });
    const ledger = await db.selectFrom('follower_trades').selectAll().execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.handled_by).toBe('worker-1');
  });

  it('50 concurrent deliveries of one event over separate connections -> one effect, one inbox row', async () => {
    await insertFollower(db, 'f1', 10_000, 2_000);
    const { copyTrades } = services(db);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        copyTrades.processRequestedEvent(event({ handledBy: `worker-${String(i % 3)}` })),
      ),
    );

    expect(results.filter((r) => !r.redelivered)).toHaveLength(1);
    expect(await db.selectFrom('follower_trades').select('id').execute()).toHaveLength(1);
    expect(await db.selectFrom('processed_events').select('event_id').execute()).toHaveLength(1);
    expect(
      await db.selectFrom('followers').select('balance').where('id', '=', 'f1').executeTakeFirst(),
    ).toEqual({ balance: 9_300 });
  });

  it('concurrent 700/700 events from different workers on 1,000 / 1,000 -> exactly one copy', async () => {
    await insertFollower(db, 'f1', 1_000, 1_000);
    const { copyTrades, reconciliation } = services(db);

    const results = await Promise.all(
      ['a', 'b'].map((id, i) =>
        copyTrades.processRequestedEvent(
          event({
            eventId: id,
            trade: { id: `t-${id}`, traderId: 'trader', amount: 700 },
            handledBy: `worker-${String(i + 1)}`,
          }),
        ),
      ),
    );

    expect(results.map((r) => r.record.outcome).sort()).toEqual(['copied', 'rejected']);
    expect(results.find((r) => r.record.outcome === 'rejected')?.record.reason).toBe(
      'INSUFFICIENT_BALANCE',
    );
    expect((await reconciliation.run()).summary.driftedFollowers).toBe(0);
  });

  it('records unknown followers as rejections and stores the source partition and offset', async () => {
    const { copyTrades } = services(db);
    const out = await copyTrades.processRequestedEvent(event({ followerId: 'ghost' }));
    expect(out.record).toMatchObject({ outcome: 'rejected', reason: 'FOLLOWER_NOT_FOUND' });
    const row = await db.selectFrom('processed_events').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ partition: 3, kafka_offset: '17', topic: 'copy-trade.requested' });
  });

  it('handled_by is immutable on the append-only ledger', async () => {
    await insertFollower(db, 'f1', 10_000, 2_000);
    await services(db).copyTrades.processRequestedEvent(event());
    await expect(
      sql`UPDATE follower_trades SET handled_by = 'someone-else'`.execute(db),
    ).rejects.toMatchObject({ code: '23001' });
  });
});

describe('event relay on Postgres', () => {
  it('4 concurrent relays publish every event exactly once (SKIP LOCKED) and mark it', async () => {
    for (let i = 0; i < 40; i++) {
      await insertFollower(db, `f${String(i)}`, 1_000, 1_000);
      await subscribe(db, `f${String(i)}`, ['trader']);
    }
    await tradeService().openTrade({ id: 'T1', traderId: 'trader', amount: 100 });
    const published: OutboxEvent[] = [];
    const publisher = {
      publish: async (events: readonly OutboxEvent[]) => {
        await delay(5);
        published.push(...events);
      },
    };
    const relays = Array.from(
      { length: 4 },
      () =>
        new EventRelayService({
          unitOfWork: new KyselyUnitOfWork(db),
          publisher,
          clock: systemClock,
          batchSize: 3,
          retryDelayMs: 0,
        }),
    );

    await Promise.all(relays.map((r) => r.drain(100)));

    expect(published).toHaveLength(40);
    expect(new Set(published.map((e) => e.eventId)).size).toBe(40);
    const unpublished = await db
      .selectFrom('event_outbox')
      .select('id')
      .where('published_at', 'is', null)
      .execute();
    expect(unpublished).toEqual([]);
  });

  it('a failed publish is rescheduled with the error and stays unpublished', async () => {
    await insertFollower(db, 'f1', 1_000, 1_000);
    await subscribe(db, 'f1', ['trader']);
    await tradeService().openTrade({ id: 'T1', traderId: 'trader', amount: 100 });
    const relay = new EventRelayService({
      unitOfWork: new KyselyUnitOfWork(db),
      publisher: { publish: () => Promise.reject(new Error('broker down')) },
      clock: systemClock,
      batchSize: 10,
      retryDelayMs: 60_000,
    });

    expect(await relay.publishBatch()).toMatchObject({ kind: 'failed', count: 1 });
    expect(await relay.publishBatch()).toEqual({ kind: 'idle' });
    const row = await db.selectFrom('event_outbox').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ attempts: 1, last_error: 'broker down', published_at: null });
  });
});

describe('KyselyInstanceRegistry', () => {
  it('upserts heartbeats, marks stops and reports liveness', async () => {
    const registry = new KyselyInstanceRegistry(db);
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const later = (ms: number) => new Date(t0.getTime() + ms);

    await registry.heartbeat({
      id: 'worker-1',
      kind: 'worker',
      startedAt: t0,
      now: t0,
      partitions: [3, 1],
    });
    await registry.heartbeat({ id: 'api-1', kind: 'api', startedAt: t0, now: later(9_000) });
    await registry.heartbeat({ id: 'worker-2', kind: 'worker', startedAt: t0, now: later(9_000) });
    await registry.markStopped('worker-2', later(9_500));

    const list = await registry.list(later(10_000), 5_000, 60_000);
    expect(list.map((i) => [i.id, i.kind, i.alive, i.partitions])).toEqual([
      ['api-1', 'api', true, []],
      ['worker-1', 'worker', false, [1, 3]],
      ['worker-2', 'worker', false, []],
    ]);
    expect(await registry.list(later(120_000), 5_000, 60_000)).toEqual([]);
  });
});
