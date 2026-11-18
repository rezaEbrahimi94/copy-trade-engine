import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decideCopyTrade,
  reconcileFollower,
  refundCopyTrade,
  type Follower,
  type Trade,
} from '../src';

const FOLLOWER_ID = 'follower';

const followerArb = fc.record({
  id: fc.constant(FOLLOWER_ID),
  balance: fc.integer({ min: 0, max: 1_000_000 }),
  remainingAllocation: fc.integer({ min: 0, max: 1_000_000 }),
  copyingEnabled: fc.boolean(),
});

const tradeArb: fc.Arbitrary<Trade> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 4 }),
  traderId: fc.constantFrom('trader-a', 'trader-b', FOLLOWER_ID),
  amount: fc.oneof(
    fc.integer({ min: 1, max: 200_000 }),
    fc.integer({ min: -1_000, max: 0 }),
    fc.double({ noNaN: false }),
  ),
});

describe('decideCopyTrade properties', () => {
  it('never produces a negative balance or allocation and debits exactly the amount', () => {
    fc.assert(
      fc.property(followerArb, tradeArb, (follower, trade) => {
        const result = decideCopyTrade(trade, follower);
        if (!result.ok) return;
        const after = result.value.follower;
        expect(after.balance).toBeGreaterThanOrEqual(0);
        expect(after.remainingAllocation).toBeGreaterThanOrEqual(0);
        expect(follower.balance - after.balance).toBe(trade.amount);
        expect(follower.remainingAllocation - after.remainingAllocation).toBe(trade.amount);
        expect(Number.isSafeInteger(after.balance)).toBe(true);
      }),
    );
  });

  it('accepts exactly when every eligibility rule holds', () => {
    fc.assert(
      fc.property(followerArb, tradeArb, (follower, trade) => {
        const eligible =
          follower.copyingEnabled &&
          trade.traderId !== follower.id &&
          Number.isSafeInteger(trade.amount) &&
          trade.amount > 0 &&
          follower.balance >= trade.amount &&
          follower.remainingAllocation >= trade.amount;
        expect(decideCopyTrade(trade, follower).ok).toBe(eligible);
      }),
    );
  });

  it('refund is the exact inverse of an accepted debit', () => {
    fc.assert(
      fc.property(followerArb, tradeArb, (follower, trade) => {
        const result = decideCopyTrade(trade, follower);
        if (result.ok) {
          expect(refundCopyTrade(result.value.follower, result.value.amount)).toEqual(follower);
        }
      }),
    );
  });

  it('any sequence of trades (with repeats) keeps the ledger reconcilable and one effect per key', () => {
    fc.assert(
      fc.property(
        followerArb,
        fc.array(tradeArb, { maxLength: 60 }),
        fc.array(fc.boolean(), { maxLength: 60 }),
        (opening, trades, failures) => {
          // Model of the service: dedupe by trade id, apply the pure rule, optionally
          // compensate (refund) the entry as a failed downstream execution.
          let follower: Follower = opening;
          const ledger = new Map<string, { amount: number; failed: boolean }>();

          trades.forEach((trade, i) => {
            if (ledger.has(trade.id)) return;
            const decision = decideCopyTrade(trade, follower);
            if (!decision.ok) return;
            follower = decision.value.follower;
            const failed = failures[i] ?? false;
            if (failed) follower = refundCopyTrade(follower, decision.value.amount);
            ledger.set(trade.id, { amount: decision.value.amount, failed });
          });

          const held = [...ledger.values()]
            .filter((e) => !e.failed)
            .reduce((sum, e) => sum + e.amount, 0);
          const report = reconcileFollower({
            followerId: opening.id,
            openingBalance: opening.balance,
            openingAllocation: opening.remainingAllocation,
            balance: follower.balance,
            remainingAllocation: follower.remainingAllocation,
            heldAmount: held,
            duplicateKeyCount: 0,
          });
          expect(report.consistent).toBe(true);
          expect(follower.balance).toBeGreaterThanOrEqual(0);
          expect(follower.remainingAllocation).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
