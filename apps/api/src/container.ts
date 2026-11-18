import {
  CopyTradeService,
  ExecutionService,
  FollowerService,
  ReconciliationService,
  type Clock,
  type IdGenerator,
  type Sleep,
} from '@copy-trade/application';
import {
  createDatabase,
  KyselyFollowerRepository,
  KyselyReconciliationRepository,
  KyselyUnitOfWork,
  type Database,
} from '@copy-trade/db';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { AppConfig } from './config';
import type { AppDeps } from './http/types';
import { SimulatedExecutionGateway } from './infrastructure/simulated-execution-gateway';
import { realSleep, systemClock, uuidGenerator } from './infrastructure/system';
import { createMetrics, createReconciliationObserver, type Metrics } from './observability/metrics';

export interface Container extends AppDeps {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly execution: ExecutionService;
  readonly metrics: Metrics;
  dispose(): Promise<void>;
}

export interface ContainerOverrides {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

/** Composition root: the only place that knows concrete implementations. */
export function createContainer(
  config: AppConfig,
  logger: Logger,
  overrides: ContainerOverrides = {},
): Container {
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? uuidGenerator;
  const metrics = createMetrics({ collectDefaults: true, instanceId: config.instanceId });

  const db = createDatabase({
    connectionString: config.db.url,
    poolMax: config.db.poolMax,
    applicationName: `${config.otel.serviceName}:${config.instanceId}`,
    statementTimeoutMs: config.db.statementTimeoutMs,
    onIdleClientError: (err) => {
      logger.warn({ err }, 'idle database client error');
    },
  });
  const unitOfWork = new KyselyUnitOfWork(db, { followerLocking: 'for-update' });

  const copyTrades = new CopyTradeService({
    unitOfWork,
    clock,
    ids,
    retry: {
      maxAttempts: config.retry.maxAttempts,
      baseDelayMs: config.retry.baseDelayMs,
      sleep: overrides.sleep ?? realSleep,
      random: overrides.random ?? Math.random,
      onRetry: (event) => {
        metrics.txRetries.inc({ reason: event.reason });
        logger.warn({ event: 'copy_trade.retry', ...event }, 'retrying copy-trade transaction');
      },
    },
  });

  const followers = new FollowerService({
    followers: new KyselyFollowerRepository(db),
    clock,
    ids,
    listLimit: config.listLimit,
  });

  const execution = new ExecutionService({
    unitOfWork,
    gateway: new SimulatedExecutionGateway(config.execution.failureTradePrefix),
    clock,
    maxAttempts: config.outbox.maxAttempts,
    retryDelayMs: config.outbox.retryDelayMs,
  });

  const reconciliation = new ReconciliationService({
    repository: new KyselyReconciliationRepository(db),
    clock,
    observer: createReconciliationObserver(metrics, logger),
    stuckPendingThresholdMs: config.reconciliation.stuckThresholdMs,
  });

  return {
    config,
    db,
    logger,
    metrics,
    ids,
    copyTrades,
    followers,
    execution,
    reconciliation,
    corsOrigin: config.http.corsOrigin,
    readinessChecks: {
      database: async () => {
        await sql`select 1`.execute(db);
        return true;
      },
    },
    dispose: () => db.destroy(),
  };
}
