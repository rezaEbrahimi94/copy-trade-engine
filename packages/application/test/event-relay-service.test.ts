import { describe, expect, it } from 'vitest';
import { EventRelayService, TradeService, type EventPublisher, type OutboxEvent } from '../src';
import { FixedClock, immediateRetry, InMemoryStore, SequentialIds } from '../testing';
import { followerRecord } from './helpers';

class RecordingPublisher implements EventPublisher {
  readonly published: OutboxEvent[][] = [];
  failWith: string | undefined;

  publish(events: readonly OutboxEvent[]): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(new Error(this.failWith));
    this.published.push([...events]);
    return Promise.resolve();
  }
}

async function setupRelay(followers = 5, batchSize = 2) {
  const store = new InMemoryStore();
  for (let i = 0; i < followers; i++) {
    store.followers.set(`f-${String(i)}`, followerRecord({ id: `f-${String(i)}` }));
    store.subscriptions.set(`f-${String(i)}`, ['trader']);
  }
  const clock = new FixedClock();
  const ids = new SequentialIds();
  await new TradeService({
    unitOfWork: store,
    reads: store,
    clock,
    ids,
    retry: immediateRetry(),
    requestedTopic: 'copy-trade.requested',
    listLimit: 10,
  }).openTrade({ id: 'T1', traderId: 'trader', amount: 100 });
  const publisher = new RecordingPublisher();
  const relay = new EventRelayService({
    unitOfWork: store,
    publisher,
    clock,
    batchSize,
    retryDelayMs: 1_000,
  });
  return { store, clock, publisher, relay };
}

describe('EventRelayService (transactional outbox -> bus)', () => {
  it('publishes a batch and marks it published in the same transaction', async () => {
    const { store, publisher, relay, clock } = await setupRelay();

    expect(await relay.publishBatch()).toEqual({ kind: 'published', count: 2 });

    expect(publisher.published[0]?.map((e) => e.key)).toEqual(['f-0', 'f-1']);
    const published = [...store.events.values()].filter((e) => e.publishedAt !== null);
    expect(published.map((e) => e.publishedAt)).toEqual([clock.now(), clock.now()]);
  });

  it('drains everything in batches and then reports idle', async () => {
    const { publisher, relay } = await setupRelay(5, 2);

    expect(await relay.drain(10)).toBe(5);
    expect(publisher.published.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(await relay.publishBatch()).toEqual({ kind: 'idle' });
  });

  it('drain stops after maxBatches', async () => {
    const { relay } = await setupRelay(5, 2);
    expect(await relay.drain(1)).toBe(2);
  });

  it('on publish failure reschedules with linear backoff and keeps events unpublished', async () => {
    const { store, publisher, relay, clock } = await setupRelay(1, 2);
    publisher.failWith = 'broker down';

    expect(await relay.publishBatch()).toEqual({ kind: 'failed', count: 1, error: 'broker down' });
    expect(await relay.drain(5)).toBe(0);
    const [event] = [...store.events.values()];
    expect(event).toMatchObject({
      attempts: 1,
      publishedAt: null,
      lastError: 'broker down',
      availableAt: new Date(clock.now().getTime() + 1_000),
    });

    clock.advance(1_000);
    expect(await relay.publishBatch()).toMatchObject({ kind: 'failed' });
    expect([...store.events.values()][0]).toMatchObject({
      attempts: 2,
      availableAt: new Date(clock.now().getTime() + 2_000),
    });

    publisher.failWith = undefined;
    clock.advance(2_000);
    expect(await relay.publishBatch()).toEqual({ kind: 'published', count: 1 });
  });

  it('records non-Error rejections as strings', async () => {
    const { store, relay } = await setupRelay(1);
    const failing = new EventRelayService({
      unitOfWork: store,
      publisher: { publish: () => Promise.reject(new Error('x', { cause: 1 })) },
      clock: new FixedClock(),
      batchSize: 1,
      retryDelayMs: 0,
    });
    const odd = new EventRelayService({
      unitOfWork: store,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      publisher: { publish: () => Promise.reject('plain') },
      clock: new FixedClock(),
      batchSize: 1,
      retryDelayMs: 0,
    });
    expect(await failing.publishBatch()).toMatchObject({ error: 'x' });
    expect(await odd.publishBatch()).toMatchObject({ error: 'plain' });
    expect(await relay.publishBatch()).toEqual({ kind: 'published', count: 1 });
  });

  it('two relays never publish the same event concurrently (skip-locked semantics)', async () => {
    const { store, publisher, clock } = await setupRelay(4, 2);
    const relays = [1, 2].map(
      () =>
        new EventRelayService({
          unitOfWork: store,
          publisher,
          clock,
          batchSize: 2,
          retryDelayMs: 0,
        }),
    );

    await Promise.all(relays.map((r) => r.publishBatch()));

    const ids = publisher.published.flat().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });
});
