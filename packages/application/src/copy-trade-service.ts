import {
  decideCopyTrade,
  type Follower,
  type FollowerTrade,
  type RejectionReason,
  type Trade,
} from '@copy-trade/domain';
import { LedgerKeyConflictError } from './errors';
import type {
  Clock,
  CopyTradeTransaction,
  CopyTradeUnitOfWork,
  FollowerRecord,
  IdGenerator,
  MessageSource,
  ProcessedEvent,
} from './ports';
import { withRetry, type RetryPolicy } from './retry';

export interface ProcessCopyTradeCommand {
  readonly trade: Trade;
  readonly followerId: string;
  readonly idempotencyKey?: string;
  /** API replica or worker processing the request; stored on the ledger row. */
  readonly handledBy?: string;
}

export interface ProcessRequestedEventCommand {
  readonly eventId: string;
  readonly trade: Trade;
  readonly followerId: string;
  readonly handledBy: string;
  readonly source: MessageSource | null;
}

/**
 * `redelivered`: the event id was already processed; `record` is the stored outcome and no
 * state changed. Otherwise `result` is the fresh outcome and `record` was stored atomically.
 */
export type ProcessRequestedEventResult =
  | { readonly redelivered: true; readonly record: ProcessedEvent }
  | {
      readonly redelivered: false;
      readonly record: ProcessedEvent;
      readonly result: CopyTradeResult;
    };

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
    return withRetry(this.#deps.retry, () =>
      this.#deps.unitOfWork.transaction(async (tx) =>
        this.#copy(tx, command, await tx.lockFollower(command.followerId)),
      ),
    );
  }

  /**
   * Idempotent consumer: the inbox check runs after the follower lock, and the inbox row is
   * written in the same transaction as the copy, so a redelivered event never has a second
   * effect and always reports the outcome of its first processing.
   */
  processRequestedEvent(
    command: ProcessRequestedEventCommand,
  ): Promise<ProcessRequestedEventResult> {
    const { eventId, trade, followerId, handledBy, source } = command;
    return withRetry(this.#deps.retry, () =>
      this.#deps.unitOfWork.transaction(async (tx): Promise<ProcessRequestedEventResult> => {
        const follower = await tx.lockFollower(followerId);
        const seen = await tx.findProcessedEvent(eventId);
        if (seen !== undefined) return { redelivered: true, record: seen };

        const result = await this.#copy(tx, { trade, followerId, handledBy }, follower);
        const record: ProcessedEvent = {
          eventId,
          tradeId: trade.id,
          followerId,
          outcome: result.outcome,
          reason: result.outcome === 'rejected' ? result.reason : null,
          followerTradeId: 'followerTrade' in result ? result.followerTrade.id : null,
          handledBy,
          source,
          processedAt: this.#deps.clock.now(),
        };
        if (!(await tx.recordProcessedEvent(record))) throw new LedgerKeyConflictError();
        return { redelivered: false, record, result };
      }),
    );
  }

  async #copy(
    tx: CopyTradeTransaction,
    command: ProcessCopyTradeCommand,
    follower: FollowerRecord | undefined,
  ): Promise<CopyTradeResult> {
    const { clock, ids } = this.#deps;
    const { trade, followerId, idempotencyKey } = command;

    if (idempotencyKey !== undefined) {
      const byKey = await tx.findFollowerTradeByIdempotencyKey(idempotencyKey);
      if (byKey !== undefined && (byKey.tradeId !== trade.id || byKey.followerId !== followerId)) {
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
      handledBy: command.handledBy ?? null,
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
  }
}
