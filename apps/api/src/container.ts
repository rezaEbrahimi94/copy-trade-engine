import {
  CopyTradeService,
  EventRelayService,
  ExecutionService,
  FollowerService,
  ReconciliationService,
  TradeService,
  type Clock,
  type IdGenerator,
  type Sleep,
} from '@copy-trade/application';
import {
  createDatabase,
  KyselyFollowerRepository,
  KyselyInstanceRegistry,
  KyselyReconciliationRepository,
  KyselyTradeReadRepository,
  KyselyUnitOfWork,
  type Database,
} from '@copy-trade/db';
import { CONSUMER_GROUP, TOPICS } from '@copy-trade/contracts';
import { createKafka, createProducer, KafkaEventPublisher } from '@copy-trade/messaging';
import type { Admin, Producer } from 'kafkajs';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { AppConfig } from './config';
import type { AppDeps } from './http/types';
import { SimulatedExecutionGateway } from './infrastructure/simulated-execution-gateway';
import { realSleep, systemClock, uuidGenerator } from '@copy-trade/platform';
import { createMetrics, createReconciliationObserver, type Metrics } from './observability/metrics';

export interface Container extends AppDeps {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly execution: ExecutionService;
  readonly metrics: Metrics;
  readonly registry: KyselyInstanceRegistry;
  /** Present when the event bus is configured. Connect `kafka` before starting the relay. */
  readonly eventRelay: EventRelayService | undefined;
  readonly kafka: { readonly producer: Producer; readonly admin: Admin } | undefined;
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

  const retry = {
    maxAttempts: config.retry.maxAttempts,
    baseDelayMs: config.retry.baseDelayMs,
    sleep: overrides.sleep ?? realSleep,
    random: overrides.random ?? Math.random,
  };
  const trades = new TradeService({
    unitOfWork,
    reads: new KyselyTradeReadRepository(db),
    clock,
    ids,
    retry,
    requestedTopic: TOPICS.requested,
    listLimit: config.listLimit,
  });

  let kafka: Container['kafka'];
  let eventRelay: EventRelayService | undefined;
  if (config.kafka !== undefined) {
    const client = createKafka({
      brokers: config.kafka.brokers,
      clientId: `${config.kafka.clientId}-${config.instanceId}`,
      logger,
    });
    kafka = { producer: createProducer(client), admin: client.admin() };
    eventRelay = new EventRelayService({
      unitOfWork,
      publisher: new KafkaEventPublisher(kafka.producer, config.instanceId),
      clock,
      batchSize: config.kafka.relayBatchSize,
      retryDelayMs: config.kafka.relayRetryDelayMs,
    });
  }

  const registry = new KyselyInstanceRegistry(db);

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
    trades,
    registry,
    eventRelay,
    kafka,
    instanceId: config.instanceId,
    instances: {
      list: () => registry.list(clock.now(), config.heartbeatIntervalMs * 3 + 1_000, 10 * 60_000),
    },
    system: {
      instanceId: config.instanceId,
      eventBus: config.kafka !== undefined,
      consoleUrl: config.consoleUrl ?? null,
      consumerGroup: CONSUMER_GROUP,
      topics: { ...TOPICS },
    },
    corsOrigin: config.http.corsOrigin,
    readinessChecks: {
      database: async () => {
        await sql`select 1`.execute(db);
        return true;
      },
    },
    dispose: async () => {
      await kafka?.producer.disconnect();
      await kafka?.admin.disconnect();
      await db.destroy();
    },
  };
}
