import { refundCopyTrade, transitionStatus } from '@copy-trade/domain';
import { InvariantViolationError } from './errors';
import type { Clock, ExecutionGateway, ExecutionUnitOfWork } from './ports';

export interface ExecutionServiceDeps {
  readonly unitOfWork: ExecutionUnitOfWork;
  readonly gateway: ExecutionGateway;
  readonly clock: Clock;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

export type ExecutionStepResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'executed' | 'compensated' | 'rescheduled' | 'skipped'; readonly id: string };

/**
 * Outbox relay: settles pending ledger entries against the downstream broker.
 * Success marks the entry executed; after `maxAttempts` failures the entry is marked
 * failed and the debit is refunded in the same transaction (idempotent compensation:
 * the conditional pending -> failed transition can only happen once).
 */
export class ExecutionService {
  readonly #deps: ExecutionServiceDeps;

  constructor(deps: ExecutionServiceDeps) {
    this.#deps = deps;
  }

  async drain(limit: number): Promise<readonly ExecutionStepResult[]> {
    const results: ExecutionStepResult[] = [];
    while (results.length < limit) {
      const step = await this.processNext();
      if (step.kind === 'idle') break;
      results.push(step);
    }
    return results;
  }

  processNext(): Promise<ExecutionStepResult> {
    const { unitOfWork, gateway, clock, maxAttempts, retryDelayMs } = this.#deps;

    return unitOfWork.transaction(async (tx): Promise<ExecutionStepResult> => {
      const now = clock.now();
      const message = await tx.claimNextDue(now);
      if (message === undefined) return { kind: 'idle' };

      const entry = await tx.getFollowerTrade(message.followerTradeId);
      if (entry === undefined) {
        throw new InvariantViolationError(`Outbox ${message.id} references a missing entry`);
      }
      if (!transitionStatus(entry.status, 'executed').ok) {
        await tx.completeMessage(message.id, now);
        return { kind: 'skipped', id: entry.id };
      }

      const result = await gateway.execute(entry);
      if (result.status === 'executed') {
        await tx.settleFollowerTrade(entry.id, 'executed', now);
        await tx.completeMessage(message.id, now);
        return { kind: 'executed', id: entry.id };
      }

      const attempts = message.attempts + 1;
      if (attempts < maxAttempts) {
        const availableAt = new Date(now.getTime() + retryDelayMs * attempts);
        await tx.rescheduleMessage(message.id, attempts, availableAt, result.error);
        return { kind: 'rescheduled', id: entry.id };
      }

      const follower = await tx.lockFollower(entry.followerId);
      if (follower === undefined) {
        throw new InvariantViolationError(`Entry ${entry.id} references a missing follower`);
      }
      const settled = await tx.settleFollowerTrade(entry.id, 'failed', now);
      if (settled) await tx.saveFollowerBalances(refundCopyTrade(follower, entry.amount), now);
      await tx.completeMessage(message.id, now);
      return { kind: settled ? 'compensated' : 'skipped', id: entry.id };
    });
  }
}
