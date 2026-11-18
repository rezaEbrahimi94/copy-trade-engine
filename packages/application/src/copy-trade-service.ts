import {
  decideCopyTrade,
  type Follower,
  type FollowerTrade,
  type RejectionReason,
  type Trade,
} from '@copy-trade/domain';
import { LedgerKeyConflictError } from './errors';
import type { Clock, CopyTradeUnitOfWork, IdGenerator } from './ports';
import { withRetry, type RetryPolicy } from './retry';

export interface ProcessCopyTradeCommand {
  readonly trade: Trade;
  readonly followerId: string;
  readonly idempotencyKey?: string;
}

export type CopyTradeResult =
  | {
      readonly outcome: 'copied' | 'duplicate';
      readonly followerTrade: FollowerTrade;
      readonly follower: Follower;
    }
  | { readonly outcome: 'rejected'; readonly reason: RejectionReason }
  | { readonly outcome: 'idempotency_key_conflict'; readonly followerTrade: FollowerTrade };

export interface CopyTradeServiceDeps {
  readonly unitOfWork: CopyTradeUnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly retry: RetryPolicy;
}

const toFollower = (f: Follower): Follower => ({
  id: f.id,
  balance: f.balance,
  remainingAllocation: f.remainingAllocation,
  copyingEnabled: f.copyingEnabled,
});

/**
 * Use case: copy one trade to one follower, exactly once.
 *
 * One transaction: lock follower row -> duplicate check -> domain eligibility ->
 * update balances -> insert ledger row (unique key) -> enqueue execution -> commit.
 * Transient DB errors and lost insert races roll back and re-run the whole transaction.
 */
export class CopyTradeService {
  readonly #deps: CopyTradeServiceDeps;

  constructor(deps: CopyTradeServiceDeps) {
    this.#deps = deps;
  }

  processCopyTrade(command: ProcessCopyTradeCommand): Promise<CopyTradeResult> {
    return withRetry(this.#deps.retry, () => this.#attempt(command));
  }

  #attempt(command: ProcessCopyTradeCommand): Promise<CopyTradeResult> {
    const { unitOfWork, clock, ids } = this.#deps;
    const { trade, followerId, idempotencyKey } = command;

    return unitOfWork.transaction(async (tx): Promise<CopyTradeResult> => {
      const follower = await tx.lockFollower(followerId);

      if (idempotencyKey !== undefined) {
        const byKey = await tx.findFollowerTradeByIdempotencyKey(idempotencyKey);
        if (
          byKey !== undefined &&
          (byKey.tradeId !== trade.id || byKey.followerId !== followerId)
        ) {
          return { outcome: 'idempotency_key_conflict', followerTrade: byKey };
        }
      }

      if (follower !== undefined) {
        const existing = await tx.findFollowerTrade(trade.id, followerId);
        if (existing !== undefined) {
          return { outcome: 'duplicate', followerTrade: existing, follower: toFollower(follower) };
        }
      }

      const decision = decideCopyTrade(trade, follower);
      if (!decision.ok) return { outcome: 'rejected', reason: decision.error };

      const now = clock.now();
      await tx.saveFollowerBalances(decision.value.follower, now);

      const inserted = await tx.insertFollowerTrade({
        id: ids.next(),
        tradeId: trade.id,
        traderId: trade.traderId,
        followerId,
        amount: decision.value.amount,
        status: 'pending',
        idempotencyKey: idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      });
      if (inserted === undefined) throw new LedgerKeyConflictError();

      await tx.enqueueExecution({
        id: ids.next(),
        followerTradeId: inserted.id,
        attempts: 0,
        availableAt: now,
      });

      return {
        outcome: 'copied',
        followerTrade: inserted,
        follower: toFollower(decision.value.follower),
      };
    });
  }
}
