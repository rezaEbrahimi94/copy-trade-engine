import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CopyTradeService, ReconciliationService, type CopyTradeResult } from '../src';
import { FixedClock, immediateRetry, InMemoryStore, SequentialIds } from '../testing';
import { followerRecord } from './helpers';

const FOLLOWERS = ['f-1', 'f-2', 'f-3'] as const;

const commandArb = fc.record({
  tradeId: fc.constantFrom('t-1', 't-2', 't-3', 't-4', 't-5', 't-6'),
  followerId: fc.constantFrom(...FOLLOWERS, 'f-missing'),
  traderId: fc.constantFrom('trader-1', 'trader-2', 'f-1'),
  amount: fc.oneof(fc.integer({ min: 1, max: 1_200 }), fc.constantFrom(0, -5, 700)),
});

const openingArb = fc.tuple(
  ...FOLLOWERS.map(() =>
    fc.record({
      balance: fc.integer({ min: 0, max: 3_000 }),
      allocation: fc.integer({ min: 0, max: 3_000 }),
      copyingEnabled: fc.boolean(),
    }),
  ),
);

/**
 * Fires every command concurrently; fast-check's scheduler decides the interleaving of every
 * storage operation, so each run explores a different concurrent schedule.
 */
function concurrencyProperty(rowLocking: boolean) {
  return fc.asyncProperty(
    fc.scheduler(),
    openingArb,
    fc.array(commandArb, { minLength: 1, maxLength: 12 }),
    async (s, openings, commands) => {
      const store = new InMemoryStore({
        rowLocking,
        yieldPoint: () => s.schedule(Promise.resolve()),
      });
      FOLLOWERS.forEach((id, i) => {
        const o = openings[i]!;
        store.followers.set(
          id,
          followerRecord({
            id,
            balance: o.balance,
            remainingAllocation: o.allocation,
            copyingEnabled: o.copyingEnabled,
          }),
        );
      });
      const clock = new FixedClock();
      const service = new CopyTradeService({
        unitOfWork: store,
        clock,
        ids: new SequentialIds(),
        retry: immediateRetry({ maxAttempts: 10 }),
      });

      const results: CopyTradeResult[] = await s.waitFor(
        Promise.all(
          commands.map((c) =>
            service.processCopyTrade({
              trade: { id: c.tradeId, traderId: c.traderId, amount: c.amount },
              followerId: c.followerId,
            }),
          ),
        ),
      );

      // 1. Never negative.
      for (const f of store.followers.values()) {
        expect(f.balance).toBeGreaterThanOrEqual(0);
        expect(f.remainingAllocation).toBeGreaterThanOrEqual(0);
      }
      // 2. At most one effect per (trade, follower): one ledger row and one `copied` per key.
      const copiedKeys = results
        .filter(
          (r): r is Extract<CopyTradeResult, { outcome: 'copied' | 'duplicate' }> =>
            r.outcome === 'copied',
        )
        .map((r) => `${r.followerTrade.tradeId}/${r.followerTrade.followerId}`);
      expect(new Set(copiedKeys).size).toBe(copiedKeys.length);
      expect(store.trades.size).toBe(copiedKeys.length);
      // 3. Duplicates return the original record.
      for (const r of results) {
        if (r.outcome === 'duplicate') {
          expect(
            store.trades.get(`${r.followerTrade.tradeId}\u0000${r.followerTrade.followerId}`),
          ).toEqual(r.followerTrade);
        }
      }
      // 4. Ledger sums match balances and allocations (reconciliation finds no drift).
      const report = await new ReconciliationService({
        repository: store,
        clock,
        observer: { onReport: () => undefined },
        stuckPendingThresholdMs: 0,
      }).run();
      expect(report.summary.driftedFollowers).toBe(0);
    },
  );
}

describe('CopyTradeService concurrency properties (fast-check scheduler)', () => {
  it('holds every invariant under arbitrary interleavings with row locking', async () => {
    await fc.assert(concurrencyProperty(true), { numRuns: 300 });
  });

  it('NEGATIVE CONTROL: the same property fails when the follower row lock is removed', async () => {
    const outcome = await fc.check(concurrencyProperty(false), { numRuns: 300, seed: 42 });
    expect(outcome.failed).toBe(true);
  });
});
