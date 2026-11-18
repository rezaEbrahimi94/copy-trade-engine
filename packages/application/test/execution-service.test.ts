import { describe, expect, it, vi } from 'vitest';
import { ExecutionService, InvariantViolationError, type ExecutionResult } from '../src';
import {
  FixedClock,
  ScriptedGateway,
  type InMemoryStore,
  type InMemoryStoreOptions,
} from '../testing';
import { followerRecord, setup as setupCopy, trade } from './helpers';

const failed: ExecutionResult = { status: 'failed', error: 'broker down' };

async function setup(
  script: (call: number) => ExecutionResult,
  options: InMemoryStoreOptions & { maxAttempts?: number } = {},
) {
  const {
    store,
    service: copy,
    clock,
  } = setupCopy({
    ...options,
    followers: [followerRecord({ balance: 1_000, remainingAllocation: 1_000 })],
  });
  await copy.processCopyTrade({ trade: trade(), followerId: 'follower-1' });
  const gateway = new ScriptedGateway((_entry, call) => script(call));
  const execution = new ExecutionService({
    unitOfWork: store,
    gateway,
    clock,
    maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: 1_000,
  });
  return { store, gateway, execution, clock };
}

const onlyTrade = (store: InMemoryStore) => [...store.trades.values()][0];
const onlyMessage = (store: InMemoryStore) => [...store.outbox.values()][0];

describe('ExecutionService (outbox relay)', () => {
  it('marks a pending entry executed and completes the message', async () => {
    const { store, execution, gateway } = await setup(() => ({ status: 'executed' }));

    expect(await execution.processNext()).toEqual({ kind: 'executed', id: 'id-000001' });
    expect(onlyTrade(store)?.status).toBe('executed');
    expect(onlyMessage(store)?.processedAt).not.toBeNull();
    expect(gateway.calls).toHaveLength(1);
    expect(await execution.processNext()).toEqual({ kind: 'idle' });
  });

  it('reschedules failures with linear backoff, then compensates (refund) after max attempts', async () => {
    const { store, execution, clock } = await setup(() => failed, { maxAttempts: 2 });

    expect(await execution.processNext()).toEqual({ kind: 'rescheduled', id: 'id-000001' });
    expect(onlyMessage(store)).toMatchObject({
      attempts: 1,
      availableAt: new Date('2026-01-01T00:00:01.000Z'),
      lastError: 'broker down',
      processedAt: null,
    });
    expect(await execution.processNext()).toEqual({ kind: 'idle' });

    clock.advance(1_000);
    expect(await execution.processNext()).toEqual({ kind: 'compensated', id: 'id-000001' });
    expect(onlyTrade(store)?.status).toBe('failed');
    expect(store.followers.get('follower-1')).toMatchObject({
      balance: 1_000,
      remainingAllocation: 1_000,
    });
  });

  it('compensation is idempotent: an already-settled entry is skipped, never refunded twice', async () => {
    const { store, execution } = await setup(() => failed, { maxAttempts: 1 });
    await execution.processNext();
    const balanceAfterRefund = store.followers.get('follower-1')?.balance;

    const message = onlyMessage(store)!;
    store.outbox.set(message.id, { ...message, processedAt: null });
    expect(await execution.processNext()).toEqual({ kind: 'skipped', id: 'id-000001' });
    expect(store.followers.get('follower-1')?.balance).toBe(balanceAfterRefund);
  });

  it('skips compensation when a concurrent settle won the race', async () => {
    const { store, execution } = await setup(() => failed, { maxAttempts: 1 });
    const settle = vi.fn(() => Promise.resolve(false));
    const original = store.transaction.bind(store);
    vi.spyOn(store, 'transaction').mockImplementation((work) =>
      original((tx) => work({ ...tx, settleFollowerTrade: settle })),
    );

    expect(await execution.processNext()).toEqual({ kind: 'skipped', id: 'id-000001' });
    expect(store.followers.get('follower-1')?.balance).toBe(300);
  });

  it('drains up to the limit and stops when idle', async () => {
    const { store, execution } = await setup(() => ({ status: 'executed' }));
    const { service } = { service: execution };
    expect(await service.drain(5)).toEqual([{ kind: 'executed', id: 'id-000001' }]);
    expect(await service.drain(0)).toEqual([]);
    expect(onlyTrade(store)?.status).toBe('executed');
  });

  it('never calls the broker again for an entry that is already settled', async () => {
    const { store, execution, gateway } = await setup(() => ({ status: 'executed' }));
    await execution.processNext();
    const message = onlyMessage(store)!;
    store.outbox.set(message.id, { ...message, processedAt: null });

    expect(await execution.processNext()).toEqual({ kind: 'skipped', id: 'id-000001' });
    expect(gateway.calls).toHaveLength(1);
    expect(onlyMessage(store)?.processedAt).not.toBeNull();
  });

  it('backs off linearly with the attempt number', async () => {
    const { store, execution, clock } = await setup(() => failed, { maxAttempts: 5 });
    await execution.processNext();
    clock.advance(1_000);
    await execution.processNext();
    expect(onlyMessage(store)).toMatchObject({
      attempts: 2,
      availableAt: new Date('2026-01-01T00:00:03.000Z'),
    });
  });

  it('drain processes at most `limit` messages', async () => {
    const { store, service: copy, clock } = setupCopy({ followers: [followerRecord()] });
    for (const id of ['a', 'b', 'c']) {
      await copy.processCopyTrade({ trade: trade({ id, amount: 10 }), followerId: 'follower-1' });
    }
    const execution = new ExecutionService({
      unitOfWork: store,
      gateway: new ScriptedGateway(() => ({ status: 'executed' })),
      clock,
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    expect(await execution.drain(2)).toHaveLength(2);
    expect(await execution.drain(2)).toHaveLength(1);
  });

  it('throws an invariant violation when the outbox references a missing entry', async () => {
    const { store, execution } = await setup(() => ({ status: 'executed' }));
    store.trades.clear();
    await expect(execution.processNext()).rejects.toThrow(
      new InvariantViolationError('Outbox id-000002 references a missing entry'),
    );
  });

  it('throws an invariant violation when compensating a missing follower', async () => {
    const { store, execution } = await setup(() => failed, { maxAttempts: 1 });
    store.followers.clear();
    await expect(execution.processNext()).rejects.toThrow(
      new InvariantViolationError('Entry id-000001 references a missing follower'),
    );
    expect(onlyTrade(store)?.status).toBe('pending');
  });

  it('two relays never process the same message (skip-locked semantics)', async () => {
    const {
      store,
      service: copy,
      clock,
    } = setupCopy({
      followers: [followerRecord()],
      yieldPoint: () => new Promise((r) => setTimeout(r, 0)),
    });
    for (let i = 0; i < 5; i++) {
      await copy.processCopyTrade({
        trade: trade({ id: `t${i}`, amount: 100 }),
        followerId: 'follower-1',
      });
    }
    const gateway = new ScriptedGateway(() => ({ status: 'executed' }));
    const relay = () =>
      new ExecutionService({ unitOfWork: store, gateway, clock, maxAttempts: 3, retryDelayMs: 0 });

    const [a, b] = await Promise.all([relay().drain(10), relay().drain(10)]);

    expect(a.length + b.length).toBe(5);
    expect(new Set(gateway.calls.map((c) => c.id)).size).toBe(5);
    expect(gateway.calls).toHaveLength(5);
  });

  it('uses the clock for due-ness', () => {
    expect(new FixedClock('2026-02-01T00:00:00.000Z').now().toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });
});
