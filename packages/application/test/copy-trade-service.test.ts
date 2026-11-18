import { describe, expect, it, vi } from 'vitest';
import { InvariantViolationError, TransientTransactionError, type CopyTradeResult } from '../src';
import { followerRecord, setup, trade } from './helpers';

const outcomes = (results: CopyTradeResult[]) => results.map((r) => r.outcome).sort();

describe('CopyTradeService', () => {
  it('scenario 1: copies a 700 trade for a 10,000 / 2,000 follower', async () => {
    const { service, store } = setup();

    const result = await service.processCopyTrade({ trade: trade(), followerId: 'follower-1' });

    expect(result).toEqual({
      outcome: 'copied',
      follower: {
        id: 'follower-1',
        balance: 9_300,
        remainingAllocation: 1_300,
        copyingEnabled: true,
      },
      followerTrade: {
        id: 'id-000001',
        tradeId: 'trade-1',
        traderId: 'trader-1',
        followerId: 'follower-1',
        amount: 700,
        status: 'pending',
        idempotencyKey: null,
        handledBy: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    expect(store.followers.get('follower-1')).toMatchObject({
      balance: 9_300,
      remainingAllocation: 1_300,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect([...store.outbox.values()]).toEqual([
      expect.objectContaining({ id: 'id-000002', followerTradeId: 'id-000001', attempts: 0 }),
    ]);
  });

  it('stores the API replica that handled the request on the ledger row', async () => {
    const { service } = setup();
    const result = await service.processCopyTrade({
      trade: trade(),
      followerId: 'follower-1',
      handledBy: 'api-2',
    });
    expect(result).toMatchObject({ followerTrade: { handledBy: 'api-2' } });
  });

  it('scenario 2a: the same trade twice sequentially has one effect', async () => {
    const { service, store } = setup();
    const command = { trade: trade(), followerId: 'follower-1' };

    const first = await service.processCopyTrade(command);
    const second = await service.processCopyTrade(command);

    expect(first.outcome).toBe('copied');
    expect(second).toEqual({
      outcome: 'duplicate',
      followerTrade: first.outcome === 'copied' ? first.followerTrade : undefined,
      follower: {
        id: 'follower-1',
        balance: 9_300,
        remainingAllocation: 1_300,
        copyingEnabled: true,
      },
    });
    expect(store.trades.size).toBe(1);
    expect(store.outbox.size).toBe(1);
  });

  it('scenario 2b: the same trade twice concurrently has one effect', async () => {
    const { service, store } = setup();
    const command = { trade: trade(), followerId: 'follower-1' };

    const results = await Promise.all([
      service.processCopyTrade(command),
      service.processCopyTrade(command),
    ]);

    expect(outcomes(results)).toEqual(['copied', 'duplicate']);
    expect(store.trades.size).toBe(1);
    expect(store.followers.get('follower-1')?.balance).toBe(9_300);
  });

  it('scenario 3: two concurrent 700 trades on 1,000 / 1,000 -> exactly one succeeds', async () => {
    const { service, store } = setup({
      followers: [followerRecord({ balance: 1_000, remainingAllocation: 1_000 })],
    });

    const results = await Promise.all([
      service.processCopyTrade({ trade: trade({ id: 'a' }), followerId: 'follower-1' }),
      service.processCopyTrade({ trade: trade({ id: 'b' }), followerId: 'follower-1' }),
    ]);

    expect(outcomes(results)).toEqual(['copied', 'rejected']);
    expect(results.find((r) => r.outcome === 'rejected')).toEqual({
      outcome: 'rejected',
      reason: 'INSUFFICIENT_BALANCE',
    });
    expect(store.followers.get('follower-1')).toMatchObject({
      balance: 300,
      remainingAllocation: 300,
    });
    expect(store.trades.size).toBe(1);
  });

  it.each([
    ['unknown follower', { followerId: 'missing' }, 'FOLLOWER_NOT_FOUND'],
    ['invalid amount', { trade: trade({ amount: 0 }) }, 'INVALID_AMOUNT'],
    ['self copy', { trade: trade({ traderId: 'follower-1' }) }, 'SELF_COPY'],
    ['insufficient balance', { trade: trade({ amount: 10_001 }) }, 'INSUFFICIENT_BALANCE'],
    ['insufficient allocation', { trade: trade({ amount: 2_001 }) }, 'INSUFFICIENT_ALLOCATION'],
  ] as const)('rejects %s without side effects', async (_name, override, reason) => {
    const { service, store } = setup();

    const result = await service.processCopyTrade({
      trade: trade(),
      followerId: 'follower-1',
      ...override,
    });

    expect(result).toEqual({ outcome: 'rejected', reason });
    expect(store.trades.size).toBe(0);
    expect(store.outbox.size).toBe(0);
    expect(store.followers.get('follower-1')?.balance).toBe(10_000);
  });

  it('rejects when copying is disabled', async () => {
    const { service } = setup({ followers: [followerRecord({ copyingEnabled: false })] });
    expect(await service.processCopyTrade({ trade: trade(), followerId: 'follower-1' })).toEqual({
      outcome: 'rejected',
      reason: 'COPYING_DISABLED',
    });
  });

  it('a duplicate is detected before eligibility, so it is reported even if funds ran out', async () => {
    const { service, store } = setup();
    await service.processCopyTrade({ trade: trade(), followerId: 'follower-1' });
    store.followers.set('follower-1', followerRecord({ balance: 0, copyingEnabled: false }));

    const again = await service.processCopyTrade({ trade: trade(), followerId: 'follower-1' });
    expect(again.outcome).toBe('duplicate');
  });

  it('skips lookups that cannot match (no key -> no key lookup, no follower -> no ledger lookup)', async () => {
    const { service, store } = setup();
    const original = store.transaction.bind(store);
    const byKey = vi.fn();
    const byTrade = vi.fn();
    vi.spyOn(store, 'transaction').mockImplementation((work) =>
      original((tx) =>
        work({
          ...tx,
          findFollowerTradeByIdempotencyKey: (k) => {
            byKey(k);
            return tx.findFollowerTradeByIdempotencyKey(k);
          },
          findFollowerTrade: (t, f) => {
            byTrade(t, f);
            return tx.findFollowerTrade(t, f);
          },
        }),
      ),
    );

    await service.processCopyTrade({ trade: trade(), followerId: 'follower-1' });
    await service.processCopyTrade({ trade: trade(), followerId: 'missing' });

    expect(byKey).not.toHaveBeenCalled();
    expect(byTrade.mock.calls).toEqual([['trade-1', 'follower-1']]);
  });

  describe('Idempotency-Key', () => {
    it('stores the key and treats a replay with the same key as a duplicate', async () => {
      const { service } = setup();
      const command = { trade: trade(), followerId: 'follower-1', idempotencyKey: 'key-1' };

      const first = await service.processCopyTrade(command);
      const second = await service.processCopyTrade(command);

      expect(first.outcome === 'copied' && first.followerTrade.idempotencyKey).toBe('key-1');
      expect(second.outcome).toBe('duplicate');
    });

    it('reports a conflict when the key is reused for a different trade', async () => {
      const { service, store } = setup();
      await service.processCopyTrade({
        trade: trade(),
        followerId: 'follower-1',
        idempotencyKey: 'k',
      });

      const reused = await service.processCopyTrade({
        trade: trade({ id: 'trade-2' }),
        followerId: 'follower-1',
        idempotencyKey: 'k',
      });

      expect(reused).toMatchObject({
        outcome: 'idempotency_key_conflict',
        followerTrade: { tradeId: 'trade-1' },
      });
      expect(store.trades.size).toBe(1);
    });

    it('reports a conflict when the key is reused for a different follower', async () => {
      const { service } = setup({
        followers: [followerRecord(), followerRecord({ id: 'follower-2' })],
      });
      await service.processCopyTrade({
        trade: trade(),
        followerId: 'follower-1',
        idempotencyKey: 'k',
      });

      const reused = await service.processCopyTrade({
        trade: trade(),
        followerId: 'follower-2',
        idempotencyKey: 'k',
      });
      expect(reused.outcome).toBe('idempotency_key_conflict');
    });

    it('rolls back the debit when the key was taken by a concurrent transaction', async () => {
      const { service, store } = setup({
        followers: [followerRecord(), followerRecord({ id: 'follower-2' })],
      });

      const results = await Promise.all([
        service.processCopyTrade({ trade: trade(), followerId: 'follower-1', idempotencyKey: 'k' }),
        service.processCopyTrade({ trade: trade(), followerId: 'follower-2', idempotencyKey: 'k' }),
      ]);

      expect(outcomes(results)).toEqual(['copied', 'idempotency_key_conflict']);
      const balances = [...store.followers.values()].map((f) => f.balance).sort();
      expect(balances).toEqual([10_000, 9_300].sort());
    });
  });

  describe('retries', () => {
    it('retries transient failures (deadlock/serialization) and succeeds once', async () => {
      const onRetry = vi.fn();
      const sleep = vi.fn(() => Promise.resolve());
      const { service, store } = setup({ retry: { onRetry, sleep } });
      store.failNextCommits('40P01', '40001');

      const result = await service.processCopyTrade({ trade: trade(), followerId: 'follower-1' });

      expect(result.outcome).toBe('copied');
      expect(store.trades.size).toBe(1);
      expect(store.followers.get('follower-1')?.balance).toBe(9_300);
      expect(onRetry.mock.calls).toEqual([
        [{ attempt: 1, delayMs: 5, reason: '40P01' }],
        [{ attempt: 2, delayMs: 10, reason: '40001' }],
      ]);
      expect(sleep.mock.calls).toEqual([[5], [10]]);
    });

    it('gives up after maxAttempts and leaves no partial effects', async () => {
      const { service, store } = setup({ retry: { maxAttempts: 2 } });
      store.failNextCommits('40001', '40001', '40001');

      await expect(
        service.processCopyTrade({ trade: trade(), followerId: 'follower-1' }),
      ).rejects.toBeInstanceOf(TransientTransactionError);
      expect(store.trades.size).toBe(0);
      expect(store.outbox.size).toBe(0);
      expect(store.followers.get('follower-1')?.balance).toBe(10_000);
    });

    it('does not retry non-transient errors', async () => {
      const onRetry = vi.fn();
      const { service, store } = setup({ retry: { onRetry } });
      const failing = new InvariantViolationError('boom');
      vi.spyOn(store, 'transaction').mockRejectedValueOnce(failing);

      await expect(
        service.processCopyTrade({ trade: trade(), followerId: 'follower-1' }),
      ).rejects.toBe(failing);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it('lost insert race without row locks is caught by the unique key and retried', async () => {
      const onRetry = vi.fn();
      const { service, store } = setup({ rowLocking: false, retry: { onRetry } });
      const command = { trade: trade(), followerId: 'follower-1' };

      const results = await Promise.all([
        service.processCopyTrade(command),
        service.processCopyTrade(command),
      ]);

      expect(outcomes(results)).toEqual(['copied', 'duplicate']);
      expect(store.trades.size).toBe(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'ledger_key_conflict' }),
      );
    });
  });
});
