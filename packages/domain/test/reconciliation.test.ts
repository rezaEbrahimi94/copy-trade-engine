import { describe, expect, it } from 'vitest';
import { reconcileFollower, summarizeReconciliation, type FollowerLedgerSnapshot } from '../src';

const snapshot = (overrides: Partial<FollowerLedgerSnapshot> = {}): FollowerLedgerSnapshot => ({
  followerId: 'f-1',
  openingBalance: 1_000,
  openingAllocation: 1_000,
  balance: 300,
  remainingAllocation: 300,
  heldAmount: 700,
  duplicateKeyCount: 0,
  ...overrides,
});

describe('reconcileFollower', () => {
  it('is consistent when balance and allocation equal opening minus held', () => {
    expect(reconcileFollower(snapshot())).toEqual({
      followerId: 'f-1',
      expectedBalance: 300,
      actualBalance: 300,
      balanceDrift: 0,
      expectedAllocation: 300,
      actualAllocation: 300,
      allocationDrift: 0,
      duplicateKeyCount: 0,
      negative: false,
      consistent: true,
    });
  });

  it('reports a lost update (two debits recorded, one applied) as drift', () => {
    const result = reconcileFollower(snapshot({ heldAmount: 1_400 }));
    expect(result).toMatchObject({
      expectedBalance: -400,
      balanceDrift: 700,
      allocationDrift: 700,
      consistent: false,
    });
  });

  it('reports allocation drift independently of balance drift', () => {
    const result = reconcileFollower(snapshot({ remainingAllocation: 250 }));
    expect(result).toMatchObject({ balanceDrift: 0, allocationDrift: -50, consistent: false });
  });

  it('flags balance drift alone', () => {
    expect(reconcileFollower(snapshot({ balance: 301 })).consistent).toBe(false);
  });

  it('flags duplicate keys even when sums match', () => {
    expect(reconcileFollower(snapshot({ duplicateKeyCount: 1 })).consistent).toBe(false);
  });

  it('flags negative balance or allocation', () => {
    const neg = snapshot({ openingBalance: 0, heldAmount: 0, balance: 0, remainingAllocation: -1 });
    expect(reconcileFollower({ ...neg, openingAllocation: -1 })).toMatchObject({
      negative: true,
      allocationDrift: 0,
      consistent: false,
    });
    expect(
      reconcileFollower(
        snapshot({ openingBalance: -1, balance: -1, heldAmount: 0, openingAllocation: 300 }),
      ),
    ).toMatchObject({ negative: true, balanceDrift: 0, consistent: false });
  });
});

describe('summarizeReconciliation', () => {
  it('aggregates drift across followers', () => {
    const results = [
      reconcileFollower(snapshot()),
      reconcileFollower(snapshot({ followerId: 'f-2', balance: 200, remainingAllocation: 400 })),
      reconcileFollower(snapshot({ followerId: 'f-3', duplicateKeyCount: 2 })),
    ];
    expect(summarizeReconciliation(results)).toEqual({
      followersChecked: 3,
      driftedFollowers: 2,
      totalAbsoluteDrift: 200,
      duplicateKeys: 2,
    });
  });

  it('returns zeros for no followers', () => {
    expect(summarizeReconciliation([])).toEqual({
      followersChecked: 0,
      driftedFollowers: 0,
      totalAbsoluteDrift: 0,
      duplicateKeys: 0,
    });
  });
});
