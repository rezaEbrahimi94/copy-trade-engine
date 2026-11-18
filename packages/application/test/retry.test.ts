import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  InvariantViolationError,
  LedgerKeyConflictError,
  TransientTransactionError,
  withRetry,
} from '../src';
import { immediateRetry } from '../testing';

describe('backoffDelay', () => {
  it('grows exponentially and is scaled by jitter', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, 10, () => 0.999))).toEqual([9, 19, 39, 79]);
    expect(backoffDelay(3, 10, () => 0)).toBe(0);
    expect(backoffDelay(2, 10, () => 0.5)).toBe(10);
  });
});

describe('withRetry', () => {
  it('returns the first successful result', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(immediateRetry(), run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries transient and ledger-key errors up to maxAttempts', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TransientTransactionError('40P01'))
      .mockRejectedValueOnce(new LedgerKeyConflictError())
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    await expect(withRetry(immediateRetry({ maxAttempts: 3, onRetry }), run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([e]) => (e as { reason: string }).reason)).toEqual([
      '40P01',
      'ledger_key_conflict',
    ]);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const error = new TransientTransactionError('40001');
    const run = vi.fn().mockRejectedValue(error);
    await expect(withRetry(immediateRetry({ maxAttempts: 3 }), run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('works without an onRetry hook', async () => {
    const run = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new TransientTransactionError('40001'))
      .mockResolvedValue(1);
    const policy = {
      maxAttempts: 2,
      baseDelayMs: 1,
      sleep: () => Promise.resolve(),
      random: () => 0,
    };
    await expect(withRetry(policy, run)).resolves.toBe(1);
  });

  it('carries the SQLSTATE and cause on TransientTransactionError', () => {
    const cause = new Error('pg');
    const error = new TransientTransactionError('40P01', { cause });
    expect(error).toMatchObject({
      code: '40P01',
      name: 'TransientTransactionError',
      message: 'Transient transaction failure (40P01)',
      cause,
    });
    expect(new LedgerKeyConflictError()).toMatchObject({
      name: 'LedgerKeyConflictError',
      message: 'Ledger key already exists',
    });
    expect(new InvariantViolationError('x').name).toBe('InvariantViolationError');
  });
});
