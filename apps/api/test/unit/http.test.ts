import {
  CopyTradeService,
  FollowerService,
  ReconciliationService,
  TradeService,
} from '@copy-trade/application';
import { TOPICS } from '@copy-trade/contracts';
import {
  FixedClock,
  immediateRetry,
  InMemoryStore,
  SequentialIds,
} from '@copy-trade/application/testing';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../../src/http/app';
import type { AppDeps } from '../../src/http/types';
import { createMetrics, createReconciliationObserver } from '../../src/observability/metrics';

let app: App | undefined;

async function setup(overrides: Partial<AppDeps> = {}) {
  const store = new InMemoryStore();
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const logger = pino({ level: 'silent' });
  const metrics = createMetrics({ collectDefaults: false, instanceId: 'test' });
  const deps: AppDeps = {
    logger,
    metrics,
    ids,
    corsOrigin: 'http://localhost:5173',
    copyTrades: new CopyTradeService({ unitOfWork: store, clock, ids, retry: immediateRetry() }),
    followers: new FollowerService({ followers: store, clock, ids, listLimit: 50 }),
    reconciliation: new ReconciliationService({
      repository: store,
      clock,
      observer: createReconciliationObserver(metrics, logger),
      stuckPendingThresholdMs: 60_000,
    }),
    readinessChecks: { database: () => Promise.resolve(true) },
    trades: new TradeService({
      unitOfWork: store,
      reads: store,
      clock,
      ids,
      retry: immediateRetry(),
      requestedTopic: TOPICS.requested,
      listLimit: 50,
    }),
    instanceId: 'api-test',
    instances: {
      list: () =>
        Promise.resolve([
          {
            id: 'worker-1',
            kind: 'worker' as const,
            startedAt: clock.now(),
            lastSeenAt: clock.now(),
            stoppedAt: null,
            alive: true,
            partitions: [0, 3],
          },
        ]),
    },
    system: {
      instanceId: 'api-test',
      eventBus: true,
      consoleUrl: 'http://localhost:8090',
      consumerGroup: 'copy-trade-workers',
      topics: { ...TOPICS },
    },
    ...overrides,
  };
  app = await buildApp(deps);
  return { app, store, metrics, deps };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const createFollower = async (
  a: App,
  balance: number,
  allocation: number,
  copyingEnabled = true,
  traderIds: string[] = [],
) => {
  const res = await a.inject({
    method: 'POST',
    url: '/v1/followers',
    payload: { balance, allocation, copyingEnabled, traderIds },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
};

const copy = (a: App, body: unknown, headers: Record<string, string> = {}) =>
  a.inject({ method: 'POST', url: '/v1/copy-trades', payload: body as object, headers });

describe('HTTP API', () => {
  it('scenario 1: 201 copied with the follower state and ledger entry', async () => {
    const { app } = await setup();
    const followerId = await createFollower(app, 10_000, 2_000);

    const res = await copy(app, {
      trade: { id: 't-1', traderId: 'trader', amount: 700 },
      followerId,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      outcome: 'copied',
      follower: {
        id: followerId,
        balance: 9_300,
        remainingAllocation: 1_300,
        copyingEnabled: true,
      },
      followerTrade: { tradeId: 't-1', amount: 700, status: 'pending', idempotencyKey: null },
    });
  });

  it('scenario 2: duplicates return 200 with the original record (same shape)', async () => {
    const { app } = await setup();
    const followerId = await createFollower(app, 10_000, 2_000);
    const body = { trade: { id: 't-1', traderId: 'trader', amount: 700 }, followerId };

    const first = await copy(app, body);
    const [second, third] = await Promise.all([copy(app, body), copy(app, body)]);

    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    expect(second.json()).toEqual({
      ...first.json<object>(),
      outcome: 'duplicate',
    });
  });

  it('scenario 3: two concurrent 700 trades on 1,000/1,000 -> one 201 and one 422', async () => {
    const { app } = await setup();
    const followerId = await createFollower(app, 1_000, 1_000);

    const responses = await Promise.all(
      ['a', 'b'].map((id) =>
        copy(app, { trade: { id, traderId: 'trader', amount: 700 }, followerId }),
      ),
    );

    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    const follower = await app.inject({ method: 'GET', url: `/v1/followers/${followerId}` });
    expect(follower.json()).toMatchObject({ balance: 300, remainingAllocation: 300 });
  });

  it.each([
    ['self copy', { traderId: 'SELF' }, 'SELF_COPY', 422],
    ['invalid amount', { amount: 0 }, 'INVALID_AMOUNT', 422],
    ['insufficient balance', { amount: 5_000 }, 'INSUFFICIENT_BALANCE', 422],
  ] as const)('rejects %s with %s', async (_n, override, reason, status) => {
    const { app } = await setup();
    const followerId = await createFollower(app, 1_000, 10_000);
    const t = { id: 't', traderId: 'trader', amount: 700, ...override };
    if (t.traderId === 'SELF') t.traderId = followerId;

    const res = await copy(app, { trade: t, followerId });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({
      outcome: 'rejected',
      reason,
      message: expect.any(String) as string,
    });
  });

  it('rejects insufficient allocation and disabled copying with 422', async () => {
    const { app } = await setup();
    const lowAllocation = await createFollower(app, 10_000, 100);
    const disabled = await createFollower(app, 10_000, 10_000, false);
    const t = { id: 't', traderId: 'trader', amount: 700 };

    expect((await copy(app, { trade: t, followerId: lowAllocation })).json()).toMatchObject({
      reason: 'INSUFFICIENT_ALLOCATION',
    });
    const res = await copy(app, { trade: t, followerId: disabled });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ reason: 'COPYING_DISABLED' });
  });

  it('rejects an unknown follower with 404', async () => {
    const { app } = await setup();
    const res = await copy(app, {
      trade: { id: 't', traderId: 'x', amount: 1 },
      followerId: 'nope',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ outcome: 'rejected', reason: 'FOLLOWER_NOT_FOUND' });
  });

  it('maps Idempotency-Key reuse for a different trade to 409', async () => {
    const { app } = await setup();
    const followerId = await createFollower(app, 10_000, 10_000);
    const headers = { 'idempotency-key': 'key-1' };

    const first = await copy(
      app,
      { trade: { id: 'a', traderId: 'x', amount: 1 }, followerId },
      headers,
    );
    const replay = await copy(
      app,
      { trade: { id: 'a', traderId: 'x', amount: 1 }, followerId },
      headers,
    );
    const reuse = await copy(
      app,
      { trade: { id: 'b', traderId: 'x', amount: 1 }, followerId },
      headers,
    );

    expect(first.json()).toMatchObject({ followerTrade: { idempotencyKey: 'key-1' } });
    expect(replay.statusCode).toBe(200);
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json()).toMatchObject({
      outcome: 'idempotency_key_conflict',
      followerTrade: { tradeId: 'a' },
    });
  });

  it.each([
    ['missing fields', {}],
    ['float amount', { trade: { id: 't', traderId: 'x', amount: 1.5 }, followerId: 'f' }],
    ['string amount', { trade: { id: 't', traderId: 'x', amount: '700' }, followerId: 'f' }],
    ['unknown field', { trade: { id: 't', traderId: 'x', amount: 1 }, followerId: 'f', x: 1 }],
    ['empty id', { trade: { id: '', traderId: 'x', amount: 1 }, followerId: 'f' }],
  ])('returns 400 VALIDATION_ERROR for %s', async (_n, body) => {
    const { app } = await setup();
    const res = await copy(app, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', requestId: expect.any(String) as string },
    });
  });

  it('manages followers: list, get, toggle, trades, 404s and validation', async () => {
    const { app } = await setup();
    const id = await createFollower(app, 500, 400);
    await copy(app, { trade: { id: 't', traderId: 'x', amount: 100 }, followerId: id });

    expect((await app.inject({ url: '/v1/followers' })).json()).toMatchObject({
      items: [{ id, balance: 400, openingBalance: 500, openingAllocation: 400 }],
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/followers/${id}`,
      payload: { copyingEnabled: false },
    });
    expect(patched.json()).toMatchObject({ copyingEnabled: false });
    expect((await app.inject({ url: `/v1/followers/${id}/trades` })).json()).toMatchObject({
      items: [{ tradeId: 't', amount: 100 }],
    });

    for (const req of [
      { url: '/v1/followers/nope' },
      { url: '/v1/followers/nope/trades' },
      { method: 'PATCH' as const, url: '/v1/followers/nope', payload: { copyingEnabled: true } },
    ]) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/followers',
      payload: { balance: -1, allocation: 1 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns 400 when the service rejects follower amounts', async () => {
    const followers = {
      create: vi.fn().mockResolvedValue({ ok: false, reason: 'INVALID_BALANCE' }),
    };
    const { app } = await setup({ followers: followers as unknown as FollowerService });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/followers',
      payload: { balance: 1, allocation: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_BALANCE' } });
  });

  it('echoes or generates x-request-id', async () => {
    const { app } = await setup();
    const echoed = await app.inject({ url: '/health/live', headers: { 'x-request-id': 'abc' } });
    const generated = await app.inject({ url: '/health/live' });
    expect(echoed.headers['x-request-id']).toBe('abc');
    expect(generated.headers['x-request-id']).toMatch(/^id-\d+$/);
  });

  it('reports readiness per dependency (200 / 503)', async () => {
    const { app } = await setup({
      readinessChecks: {
        database: () => Promise.resolve(true),
        broker: () => Promise.reject(new Error('down')),
        cache: () => Promise.resolve(false),
      },
    });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'ok', broker: 'failed', cache: 'failed' },
    });

    await app.close();
    const healthy = await setup();
    expect((await healthy.app.inject({ url: '/health/ready' })).json()).toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('exposes Prometheus metrics including outcomes and reconciliation gauges', async () => {
    const { app } = await setup();
    const followerId = await createFollower(app, 1_000, 1_000);
    await copy(app, { trade: { id: 'a', traderId: 'x', amount: 700 }, followerId });
    await copy(app, { trade: { id: 'b', traderId: 'x', amount: 700 }, followerId });
    await copy(app, { trade: { id: 'a', traderId: 'x', amount: 700 }, followerId });
    const recon = await app.inject({ url: '/v1/reconciliation' });
    expect(recon.json()).toMatchObject({ consistent: true, summary: { followersChecked: 1 } });

    const res = await app.inject({ url: '/metrics' });
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain(
      'copy_trade_outcomes_total{outcome="copied",reason="",instance_id="test"} 1',
    );
    expect(res.body).toContain('outcome="rejected",reason="INSUFFICIENT_BALANCE"');
    expect(res.body).toContain('outcome="duplicate"');
    expect(res.body).toContain('reconciliation_drifted_followers{instance_id="test"} 0');
    expect(res.body).toMatch(
      /http_request_duration_seconds_count\{instance_id="test",method="POST",route="\/v1\/copy-trades",status_code="201"\} 1/,
    );
  });

  it('reports drift via the endpoint and re-drives stuck entries explicitly', async () => {
    const { app, store } = await setup();
    const followerId = await createFollower(app, 1_000, 1_000);
    await copy(app, { trade: { id: 'a', traderId: 'x', amount: 700 }, followerId });
    store.followers.set(followerId, { ...store.followers.get(followerId)!, balance: 1_000 });

    const res = await app.inject({ url: '/v1/reconciliation' });
    expect(res.json()).toMatchObject({
      consistent: false,
      drifted: [{ followerId, balanceDrift: 700 }],
    });
    const redrive = await app.inject({ method: 'POST', url: '/v1/reconciliation/redrive' });
    expect(redrive.json()).toEqual({ requeued: 0 });
  });

  it('maps unexpected errors to 500 without leaking details, and unknown routes to 404', async () => {
    const copyTrades = { processCopyTrade: vi.fn().mockRejectedValue(new Error('secret detail')) };
    const { app } = await setup({ copyTrades: copyTrades as unknown as CopyTradeService });

    const res = await copy(app, { trade: { id: 't', traderId: 'x', amount: 1 }, followerId: 'f' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(res.body).not.toContain('secret');

    const missing = await app.inject({ url: '/nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('passes through client errors raised by Fastify (e.g. malformed JSON)', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/copy-trades',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'FST_ERR_CTP_INVALID_JSON_BODY' } });
  });

  it('serves the OpenAPI document', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/docs/json' });
    expect(res.json()).toMatchObject({
      paths: { '/v1/copy-trades': { post: expect.any(Object) as object } },
    });
  });

  it('every response carries the serving replica in x-instance-id and the ledger row records it', async () => {
    const { app } = await setup();
    const followerId = await createFollower(app, 10_000, 2_000);
    const res = await copy(app, {
      trade: { id: 't-1', traderId: 'trader', amount: 700 },
      followerId,
    });

    expect(res.headers['x-instance-id']).toBe('api-test');
    expect(res.json()).toMatchObject({ followerTrade: { handledBy: 'api-test' } });
    const health = await app.inject({ method: 'GET', url: '/health/live' });
    expect(health.headers['x-instance-id']).toBe('api-test');
  });

  it('opens a trade: 202 with the fanned-out followers, 200 duplicate, 409 conflict, 400 invalid', async () => {
    const { app, store } = await setup();
    const subscribed = await createFollower(app, 1_000, 1_000, true, ['trader-x']);
    await createFollower(app, 1_000, 1_000, true, ['someone-else']);
    const open = (payload: object) => app.inject({ method: 'POST', url: '/v1/trades', payload });
    const trade = { id: 'T1', traderId: 'trader-x', amount: 700 };

    const accepted = await open(trade);
    const duplicate = await open(trade);
    const conflict = await open({ ...trade, amount: 5 });
    const invalid = await open({ ...trade, id: 'T2', amount: 0 });

    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      outcome: 'accepted',
      trade: { id: 'T1', traderId: 'trader-x', amount: 700 },
      requestedFollowerIds: [subscribed],
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      outcome: 'duplicate',
      requestedFollowerIds: [subscribed],
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ outcome: 'trade_conflict', trade: { amount: 700 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_AMOUNT' } });
    expect(store.events.size).toBe(1);
  });

  it('shows trade views, lists trades and forces redelivery', async () => {
    const { app, store } = await setup();
    const followerId = await createFollower(app, 1_000, 1_000, true, ['trader-x']);
    await app.inject({
      method: 'POST',
      url: '/v1/trades',
      payload: { id: 'T1', traderId: 'trader-x', amount: 700 },
    });
    const [event] = [...store.events.values()];
    store.processedEvents.set(event!.eventId, {
      eventId: event!.eventId,
      tradeId: 'T1',
      followerId,
      outcome: 'copied',
      reason: null,
      followerTradeId: 'ft-1',
      handledBy: 'worker-2',
      source: { topic: TOPICS.requested, partition: 4, offset: '9' },
      processedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const view = await app.inject({ method: 'GET', url: '/v1/trades/T1' });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      trade: { id: 'T1' },
      requests: [
        {
          followerId,
          publishedAt: null,
          processed: { outcome: 'copied', handledBy: 'worker-2', partition: 4, offset: '9' },
        },
      ],
    });
    const list = await app.inject({ method: 'GET', url: '/v1/trades' });
    expect(list.json()).toMatchObject({ items: [{ trade: { id: 'T1' } }] });

    const republish = await app.inject({ method: 'POST', url: '/v1/trades/T1/republish' });
    expect(republish.statusCode).toBe(202);
    expect(republish.json()).toEqual({ republished: 1 });
    expect(store.events.size).toBe(2);

    expect((await app.inject({ method: 'GET', url: '/v1/trades/nope' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/trades/nope/republish' })).statusCode,
    ).toBe(404);
  });

  it('reports instances and system info for the operations UI', async () => {
    const { app } = await setup();
    const instances = await app.inject({ method: 'GET', url: '/v1/instances' });
    expect(instances.json()).toEqual({
      items: [
        {
          id: 'worker-1',
          kind: 'worker',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          stoppedAt: null,
          alive: true,
          partitions: [0, 3],
        },
      ],
    });
    const system = await app.inject({ method: 'GET', url: '/v1/system' });
    expect(system.json()).toMatchObject({
      instanceId: 'api-test',
      eventBus: true,
      consoleUrl: 'http://localhost:8090',
      topics: { requested: 'copy-trade.requested', deadLetter: 'copy-trade.requested.dlq' },
    });
  });
});
