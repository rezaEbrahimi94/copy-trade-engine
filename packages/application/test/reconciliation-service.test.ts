import { describe, expect, it, vi } from 'vitest';
import { ReconciliationService, type ReconciliationReport } from '../src';
import { followerRecord, setup, trade } from './helpers';

async function scenario() {
  const ctx = setup({
    followers: [followerRecord(), followerRecord({ id: 'follower-2', balance: 500 })],
  });
  await ctx.service.processCopyTrade({ trade: trade(), followerId: 'follower-1' });
  const reports: ReconciliationReport[] = [];
  const reconciliation = new ReconciliationService({
    repository: ctx.store,
    clock: ctx.clock,
    observer: { onReport: (r) => reports.push(r) },
    stuckPendingThresholdMs: 60_000,
  });
  return { ...ctx, reconciliation, reports };
}

describe('ReconciliationService', () => {
  it('reports a consistent ledger and notifies the observer', async () => {
    const { reconciliation, reports } = await scenario();

    const report = await reconciliation.run();

    expect(report).toEqual({
      checkedAt: new Date('2026-01-01T00:00:00.000Z'),
      summary: {
        followersChecked: 2,
        driftedFollowers: 0,
        totalAbsoluteDrift: 0,
        duplicateKeys: 0,
      },
      stuckPending: 0,
      drifted: [],
    });
    expect(reports).toEqual([report]);
  });

  it('detects drift and never modifies balances', async () => {
    const { reconciliation, store } = await scenario();
    const tampered = { ...store.followers.get('follower-1')!, balance: 9_999 };
    store.followers.set('follower-1', tampered);

    const report = await reconciliation.run();

    expect(report.summary.driftedFollowers).toBe(1);
    expect(report.drifted).toEqual([
      expect.objectContaining({ followerId: 'follower-1', balanceDrift: 699, consistent: false }),
    ]);
    expect(store.followers.get('follower-1')).toBe(tampered);
  });

  it('counts pending entries older than the threshold as stuck and re-drives them explicitly', async () => {
    const { reconciliation, clock, store } = await scenario();
    const message = [...store.outbox.values()][0]!;
    store.outbox.set(message.id, { ...message, processedAt: new Date(0) });

    clock.advance(59_999);
    expect((await reconciliation.run()).stuckPending).toBe(0);
    clock.advance(2);
    expect((await reconciliation.run()).stuckPending).toBe(1);

    const spy = vi.spyOn(store, 'requeueStuckPending');
    expect(await reconciliation.redriveStuck()).toBe(1);
    expect(spy).toHaveBeenCalledWith(
      new Date('2026-01-01T00:00:00.001Z'),
      new Date('2026-01-01T00:01:00.001Z'),
    );
    expect([...store.outbox.values()][0]).toMatchObject({ processedAt: null });
  });
});
