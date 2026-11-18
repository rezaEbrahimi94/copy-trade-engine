import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly poolMax: number;
  readonly applicationName: string;
  readonly statementTimeoutMs: number;
  /**
   * Idle pooled clients emit 'error' when the server drops them (failover, restart). Unhandled,
   * that event crashes the process; the pool discards the client and reconnects on demand.
   */
  readonly onIdleClientError?: (error: Error) => void;
}

/** BIGINT -> number, refusing values that cannot be represented exactly. */
export function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`BIGINT ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}

/** Per-pool overrides (not the process-global `pg.types`) so other pg users are unaffected. */
function createTypeOverrides(): pg.TypeOverrides {
  const types = new pg.TypeOverrides();
  types.setTypeParser(pg.types.builtins.INT8, parseSafeInteger);
  return types;
}

export function createDatabase(config: DatabaseConfig): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    application_name: config.applicationName,
    statement_timeout: config.statementTimeoutMs,
    types: createTypeOverrides(),
  });
  pool.on('error', config.onIdleClientError ?? (() => undefined));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
