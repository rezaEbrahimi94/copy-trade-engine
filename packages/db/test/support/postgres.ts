import { setTimeout as delay } from 'node:timers/promises';
import { CopyTradeService, ReconciliationService, type Clock } from '@copy-trade/application';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import {
  createDatabase,
  KyselyReconciliationRepository,
  KyselyUnitOfWork,
  migrateToLatest,
} from '../../src';
import type { Database, UnitOfWorkOptions } from '../../src';

export const POSTGRES_IMAGE = 'postgres:17-alpine';

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  readonly url: string;
  connect(poolMax?: number, applicationName?: string): Kysely<Database>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();
  const url = container.getConnectionUri();
  const connections: Kysely<Database>[] = [];
  const connect = (poolMax = 10, applicationName = 'test') => {
    const db = createDatabase({
      connectionString: url,
      poolMax,
      applicationName,
      statementTimeoutMs: 30_000,
    });
    connections.push(db);
    return db;
  };
  const admin = connect(2, 'admin');
  await migrateToLatest(admin);

  return {
    container,
    url,
    connect,
    async reset() {
      // The ledger is append-only (trigger blocks DELETE); TRUNCATE is the test-only escape hatch.
      await sql`
        TRUNCATE processed_events, event_outbox, trades, follower_subscriptions, instances,
                 outbox, follower_trades, followers
      `.execute(admin);
    },
    async stop() {
      await Promise.all(connections.map((c) => c.destroy()));
      await container.stop();
    },
  };
}

export const systemClock: Clock = { now: () => new Date() };

let counter = 0;
export const ids = { next: () => `id-${String(process.pid)}-${String(++counter)}` };

export function services(db: Kysely<Database>, options?: UnitOfWorkOptions) {
  const unitOfWork = new KyselyUnitOfWork(db, options);
  const retries: string[] = [];
  const copyTrades = new CopyTradeService({
    unitOfWork,
    clock: systemClock,
    ids,
    retry: {
      maxAttempts: 10,
      baseDelayMs: 5,
      sleep: (ms) => delay(ms).then(() => undefined),
      random: Math.random,
      onRetry: (e) => retries.push(e.reason),
    },
  });
  const reconciliation = new ReconciliationService({
    repository: new KyselyReconciliationRepository(db),
    clock: systemClock,
    observer: { onReport: () => undefined },
    stuckPendingThresholdMs: 60_000,
  });
  return { unitOfWork, copyTrades, reconciliation, retries };
}

export async function insertFollower(
  db: Kysely<Database>,
  id: string,
  balance: number,
  allocation: number,
  copyingEnabled = true,
): Promise<void> {
  const now = new Date();
  await db
    .insertInto('followers')
    .values({
      id,
      balance,
      remaining_allocation: allocation,
      opening_balance: balance,
      opening_allocation: allocation,
      copying_enabled: copyingEnabled,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

export async function subscribe(
  db: Kysely<Database>,
  followerId: string,
  traderIds: readonly string[],
): Promise<void> {
  if (traderIds.length === 0) return;
  await db
    .insertInto('follower_subscriptions')
    .values(
      traderIds.map((traderId) => ({
        follower_id: followerId,
        trader_id: traderId,
        created_at: new Date(),
      })),
    )
    .execute();
}
