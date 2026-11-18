import type { MinorUnits } from './money';

export interface FollowerLedgerSnapshot {
  readonly followerId: string;
  readonly openingBalance: MinorUnits;
  readonly openingAllocation: MinorUnits;
  readonly balance: MinorUnits;
  readonly remainingAllocation: MinorUnits;
  /** Sum of amounts of ledger entries that currently hold funds (pending + executed). */
  readonly heldAmount: MinorUnits;
  /** Number of (tradeId) keys for this follower that have more than one ledger row. */
  readonly duplicateKeyCount: number;
}

export interface FollowerReconciliation {
  readonly followerId: string;
  readonly expectedBalance: MinorUnits;
  readonly actualBalance: MinorUnits;
  readonly balanceDrift: MinorUnits;
  readonly expectedAllocation: MinorUnits;
  readonly actualAllocation: MinorUnits;
  readonly allocationDrift: MinorUnits;
  readonly duplicateKeyCount: number;
  readonly negative: boolean;
  readonly consistent: boolean;
}

/** balance = opening - held, allocation = opening - held, at most one row per key, never negative. */
export function reconcileFollower(snapshot: FollowerLedgerSnapshot): FollowerReconciliation {
  const expectedBalance = snapshot.openingBalance - snapshot.heldAmount;
  const expectedAllocation = snapshot.openingAllocation - snapshot.heldAmount;
  const balanceDrift = snapshot.balance - expectedBalance;
  const allocationDrift = snapshot.remainingAllocation - expectedAllocation;
  const negative = snapshot.balance < 0 || snapshot.remainingAllocation < 0;

  return {
    followerId: snapshot.followerId,
    expectedBalance,
    actualBalance: snapshot.balance,
    balanceDrift,
    expectedAllocation,
    actualAllocation: snapshot.remainingAllocation,
    allocationDrift,
    duplicateKeyCount: snapshot.duplicateKeyCount,
    negative,
    consistent:
      balanceDrift === 0 && allocationDrift === 0 && snapshot.duplicateKeyCount === 0 && !negative,
  };
}

export interface ReconciliationSummary {
  readonly followersChecked: number;
  readonly driftedFollowers: number;
  readonly totalAbsoluteDrift: MinorUnits;
  readonly duplicateKeys: number;
}

export function summarizeReconciliation(
  results: readonly FollowerReconciliation[],
): ReconciliationSummary {
  return results.reduce<ReconciliationSummary>(
    (acc, r) => ({
      followersChecked: acc.followersChecked + 1,
      driftedFollowers: acc.driftedFollowers + (r.consistent ? 0 : 1),
      totalAbsoluteDrift:
        acc.totalAbsoluteDrift + Math.abs(r.balanceDrift) + Math.abs(r.allocationDrift),
      duplicateKeys: acc.duplicateKeys + r.duplicateKeyCount,
    }),
    { followersChecked: 0, driftedFollowers: 0, totalAbsoluteDrift: 0, duplicateKeys: 0 },
  );
}
