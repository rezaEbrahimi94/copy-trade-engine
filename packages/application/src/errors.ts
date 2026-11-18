/** Thrown by adapters for errors that are safe to retry with a fresh transaction (40P01, 40001). */
export class TransientTransactionError extends Error {
  override readonly name = 'TransientTransactionError';
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(`Transient transaction failure (${code})`, options);
    this.code = code;
  }
}

/** A concurrent writer inserted the same ledger key first; the transaction must roll back. */
export class LedgerKeyConflictError extends Error {
  override readonly name = 'LedgerKeyConflictError';

  constructor() {
    super('Ledger key already exists');
  }
}

/** A storage invariant was violated (e.g. a locked row disappeared). Never retried. */
export class InvariantViolationError extends Error {
  override readonly name = 'InvariantViolationError';
}
