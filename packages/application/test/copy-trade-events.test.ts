import { describe, expect, it } from 'vitest';
import type { ProcessRequestedEventCommand } from '../src';
import { followerRecord, setup, trade } from './helpers';

const event = (overrides: Partial<ProcessRequestedEventCommand> = {}) => ({
  eventId: 'evt-1',
  trade: trade(),
  followerId: 'follower-1',
  handledBy: 'worker-1',
  source: { topic: 'copy-trade.requested', partition: 2, offset: '41' },
  ...overrides,
});

describe('CopyTradeService.processRequestedEvent (idempotent consumer)', () => {
  it('copies, stores handledBy on the ledger row and records the inbox row atomically', async () => {
    const { store, service, clock } = setup();

    const out = await service.processRequestedEvent(event());

    expect(out.redelivered).toBe(false);
    expect(out.record).toEqual({
      eventId: 'evt-1',
      tradeId: 'trade-1',
      followerId: 'follower-1',
      outcome: 'copied',
      reason: null,
      followerTradeId: 'id-000001',
      handledBy: 'worker-1',
      source: { topic: 'copy-trade.requested', partition: 2, offset: '41' },
      processedAt: clock.now(),
    });
    expect(store.processedEvents.get('evt-1')).toEqual(out.record);
    expect([...store.trades.values()][0]?.handledBy).toBe('worker-1');
    expect(store.followers.get('follower-1')).toMatchObject({ balance: 9_300 });
  });

  it('a redelivered event (same id) has no second effect and returns the stored outcome', async () => {
    const { store, service } = setup();
    const first = await service.processRequestedEvent(event());

    const again = await service.processRequestedEvent(event({ handledBy: 'worker-2' }));

    expect(again).toEqual({ redelivered: true, record: first.record });
    expect(store.trades.size).toBe(1);
    expect(store.followers.get('follower-1')).toMatchObject({ balance: 9_300 });
  });

  it('a different event for the same trade and follower is recorded as duplicate', async () => {
    const { store, service } = setup();
    const first = await service.processRequestedEvent(event());

    const second = await service.processRequestedEvent(event({ eventId: 'evt-2' }));

    expect(second.redelivered).toBe(false);
    expect(second.record).toMatchObject({
      outcome: 'duplicate',
      followerTradeId: first.record.followerTradeId,
    });
    expect(store.trades.size).toBe(1);
    expect(store.processedEvents.size).toBe(2);
  });

  it('records rejections with their reason, including unknown followers', async () => {
    const { store, service } = setup({
      followers: [followerRecord({ balance: 100 })],
    });

    const poor = await service.processRequestedEvent(event());
    const missing = await service.processRequestedEvent(
      event({ eventId: 'evt-2', followerId: 'nobody' }),
    );

    expect(poor.record).toMatchObject({
      outcome: 'rejected',
      reason: 'INSUFFICIENT_BALANCE',
      followerTradeId: null,
    });
    expect(missing.record).toMatchObject({ outcome: 'rejected', reason: 'FOLLOWER_NOT_FOUND' });
    expect(store.processedEvents.size).toBe(2);
    expect(store.trades.size).toBe(0);
  });

  it('two workers processing the same event concurrently produce one effect', async () => {
    const { store, service } = setup();

    const results = await Promise.all([
      service.processRequestedEvent(event({ handledBy: 'worker-1' })),
      service.processRequestedEvent(event({ handledBy: 'worker-2' })),
    ]);

    expect(results.map((r) => r.redelivered).sort()).toEqual([false, true]);
    expect(store.trades.size).toBe(1);
    expect(store.processedEvents.size).toBe(1);
  });

  it('concurrent 700/700 events on 1,000 / 1,000 from different workers: exactly one copy', async () => {
    const { store, service } = setup({
      followers: [followerRecord({ balance: 1_000, remainingAllocation: 1_000 })],
    });

    const results = await Promise.all([
      service.processRequestedEvent(event({ eventId: 'a', trade: trade({ id: 't-a' }) })),
      service.processRequestedEvent(
        event({ eventId: 'b', trade: trade({ id: 't-b' }), handledBy: 'worker-2' }),
      ),
    ]);

    expect(results.map((r) => r.record.outcome).sort()).toEqual(['copied', 'rejected']);
    expect(store.followers.get('follower-1')).toMatchObject({
      balance: 300,
      remainingAllocation: 300,
    });
  });

  it('retries when the inbox row was taken by a concurrent transaction, then reports redelivery', async () => {
    const { store, service } = setup({ rowLocking: false });
    const original = store.transaction.bind(store);
    let injected = false;
    store.transaction = (work) =>
      original(async (tx) => {
        if (!injected) {
          injected = true;
          const record = tx.recordProcessedEvent.bind(tx);
          tx.recordProcessedEvent = async (r) => {
            store.processedEvents.set(r.eventId, { ...r, handledBy: 'worker-other' });
            return record(r);
          };
        }
        return work(tx);
      });

    const out = await service.processRequestedEvent(event());

    expect(out).toMatchObject({ redelivered: true, record: { handledBy: 'worker-other' } });
    expect(store.trades.size).toBe(0);
    expect(store.followers.get('follower-1')).toMatchObject({ balance: 10_000 });
  });
});
