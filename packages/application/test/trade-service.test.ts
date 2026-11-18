import { describe, expect, it } from 'vitest';
import { InvariantViolationError, TradeService, type TradeTransaction } from '../src';
import { FixedClock, immediateRetry, InMemoryStore, SequentialIds } from '../testing';
import { followerRecord } from './helpers';

const TOPIC = 'copy-trade.requested';

function setupTrades(failNextCommits: string[] = []) {
  const store = new InMemoryStore();
  store.failNextCommits(...failNextCommits);
  const subscribe = (id: string, traderIds: string[], copyingEnabled = true) => {
    store.followers.set(id, followerRecord({ id, copyingEnabled }));
    store.subscriptions.set(id, traderIds);
  };
  subscribe('f-1', ['trader-a']);
  subscribe('f-2', ['trader-a', 'trader-b']);
  subscribe('f-off', ['trader-a'], false);
  subscribe('f-other', ['trader-b']);
  subscribe('trader-a', ['trader-a']);
  const clock = new FixedClock();
  const service = new TradeService({
    unitOfWork: store,
    reads: store,
    clock,
    ids: new SequentialIds(),
    retry: immediateRetry(),
    requestedTopic: TOPIC,
    listLimit: 2,
  });
  return { store, clock, service };
}

const trade = { id: 'T1', traderId: 'trader-a', amount: 700 };

describe('TradeService', () => {
  it('stores the trade and one TradeOpened outbox event per eligible follower in one transaction', async () => {
    const { store, service, clock } = setupTrades();

    const result = await service.openTrade(trade);

    expect(result).toEqual({
      outcome: 'accepted',
      trade: { ...trade, createdAt: clock.now() },
      requestedFollowerIds: ['f-1', 'f-2'],
    });
    const events = [...store.events.values()];
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: 'id-000002',
      eventId: 'id-000001',
      topic: TOPIC,
      key: 'f-1',
      tradeId: 'T1',
      payload: {
        eventId: 'id-000001',
        type: 'TradeOpened',
        version: 1,
        occurredAt: '2026-01-01T00:00:00.000Z',
        trade,
        followerId: 'f-1',
      },
      attempts: 0,
      availableAt: clock.now(),
      publishedAt: null,
      lastError: null,
    });
  });

  it('opening the same trade again is idempotent: duplicate, same followers, no new events', async () => {
    const { store, service } = setupTrades();
    await service.openTrade(trade);

    const again = await service.openTrade(trade);

    expect(again).toMatchObject({ outcome: 'duplicate', requestedFollowerIds: ['f-1', 'f-2'] });
    expect(store.events.size).toBe(2);
  });

  it.each([
    { traderId: 'trader-b', amount: 700 },
    { traderId: 'trader-a', amount: 701 },
  ])('reusing a trade id with different content is a conflict (%o)', async (changes) => {
    const { store, service } = setupTrades();
    await service.openTrade(trade);

    const conflict = await service.openTrade({ ...trade, ...changes });

    expect(conflict).toMatchObject({ outcome: 'trade_conflict', trade: { amount: 700 } });
    expect(store.events.size).toBe(2);
  });

  it.each([0, -1, 1.5])('rejects invalid amount %d without storing anything', async (amount) => {
    const { store, service } = setupTrades();
    expect(await service.openTrade({ ...trade, amount })).toEqual({ outcome: 'invalid_amount' });
    expect(store.openedTrades.size).toBe(0);
  });

  it('a trade with no subscribers is stored with no events', async () => {
    const { store, service } = setupTrades();
    const result = await service.openTrade({ ...trade, traderId: 'nobody' });
    expect(result).toMatchObject({ outcome: 'accepted', requestedFollowerIds: [] });
    expect(store.events.size).toBe(0);
  });

  it('retries transient failures and rolls back partial fan-out', async () => {
    const { store, service } = setupTrades(['40001']);
    expect(await service.openTrade(trade)).toMatchObject({ outcome: 'accepted' });
    expect(store.events.size).toBe(2);
    expect(store.openedTrades.size).toBe(1);
  });

  it('throws an invariant violation when the conflicting trade cannot be read', async () => {
    const { store, service } = setupTrades();
    const original = store.transaction.bind(store);
    store.transaction = (work) =>
      original((tx) => {
        const broken: TradeTransaction = {
          ...tx,
          insertTrade: () => Promise.resolve(undefined),
          findTrade: () => Promise.resolve(undefined),
        };
        return work({ ...tx, ...broken });
      });

    await expect(service.openTrade(trade)).rejects.toThrow(InvariantViolationError);
    await expect(service.openTrade(trade)).rejects.toThrow('Trade T1 conflicted but is missing');
  });

  it('republish re-enqueues the original events with the same event ids (forced redelivery)', async () => {
    const { store, service, clock } = setupTrades();
    await service.openTrade(trade);
    clock.advance(1_000);

    expect(await service.republish('T1')).toBe(2);
    expect(await service.republish('missing')).toBeUndefined();

    const events = [...store.events.values()];
    expect(events).toHaveLength(4);
    expect(events.slice(2).map((e) => e.eventId)).toEqual(events.slice(0, 2).map((e) => e.eventId));
    expect(events[2]).toMatchObject({ id: 'id-000005', attempts: 0, availableAt: clock.now() });
  });

  it('reads trade views with per-follower publication and processing status', async () => {
    const { store, service, clock } = setupTrades();
    await service.openTrade(trade);
    clock.advance(1);
    await service.openTrade({ ...trade, id: 'T2' });
    clock.advance(1);
    await service.openTrade({ ...trade, id: 'T3' });
    const [first] = [...store.events.values()];
    store.events.set(first!.id, { ...first!, publishedAt: clock.now() });
    store.processedEvents.set(first!.eventId, {
      eventId: first!.eventId,
      tradeId: 'T1',
      followerId: 'f-1',
      outcome: 'copied',
      reason: null,
      followerTradeId: 'ft-1',
      handledBy: 'worker-1',
      source: null,
      processedAt: clock.now(),
    });

    const view = await service.get('T1');
    expect(view?.requests).toEqual([
      expect.objectContaining({
        followerId: 'f-1',
        publishedAt: clock.now(),
        processed: expect.objectContaining({ handledBy: 'worker-1' }) as unknown,
      }),
      expect.objectContaining({ followerId: 'f-2', publishedAt: null, processed: null }),
    ]);
    expect(await service.get('missing')).toBeUndefined();
    expect((await service.list()).map((v) => v.trade.id)).toEqual(['T3', 'T2']);
  });
});
