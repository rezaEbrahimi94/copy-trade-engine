import { TransientTransactionError } from '@copy-trade/application';

/** SQLSTATEs where re-running the whole transaction is safe and expected to succeed. */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export const pgErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

export function toApplicationError(error: unknown): unknown {
  const code = pgErrorCode(error);
  return code !== undefined && TRANSIENT_SQLSTATES.has(code)
    ? new TransientTransactionError(code, { cause: error })
    : error;
}
