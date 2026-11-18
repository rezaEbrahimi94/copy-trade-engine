import { LedgerKeyConflictError, TransientTransactionError } from './errors';
import type { Sleep } from './ports';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly sleep: Sleep;
  /** Returns a value in [0, 1); injected so backoff jitter is deterministic in tests. */
  readonly random: () => number;
  readonly onRetry?: (event: RetryEvent) => void;
}

export interface RetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
}

const isRetryable = (error: unknown): error is TransientTransactionError | LedgerKeyConflictError =>
  error instanceof TransientTransactionError || error instanceof LedgerKeyConflictError;

/** Exponential backoff with full jitter: delay in [0, base * 2^(attempt-1)). */
export const backoffDelay = (attempt: number, baseDelayMs: number, random: () => number): number =>
  Math.floor(random() * baseDelayMs * 2 ** (attempt - 1));

export async function withRetry<T>(policy: RetryPolicy, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryable(error) || attempt >= policy.maxAttempts) throw error;
      const delayMs = backoffDelay(attempt, policy.baseDelayMs, policy.random);
      policy.onRetry?.({
        attempt,
        delayMs,
        reason: error instanceof TransientTransactionError ? error.code : 'ledger_key_conflict',
      });
      await policy.sleep(delayMs);
    }
  }
}
