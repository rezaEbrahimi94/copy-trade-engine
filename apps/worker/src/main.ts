import { createServer } from 'node:http';
import { CopyTradeService } from '@copy-trade/application';
import { TOPICS } from '@copy-trade/contracts';
import { createDatabase, KyselyInstanceRegistry, KyselyUnitOfWork } from '@copy-trade/db';
import {
  createKafka,
  createProducer,
  ensureTopics,
  KafkaWorkerOutput,
} from '@copy-trade/messaging';
import {
  createServiceLogger,
  realSleep,
  resolveInstanceId,
  startPeriodicTask,
  systemClock,
  uuidGenerator,
  type PeriodicTask,
} from '@copy-trade/platform';
import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config';
import { CopyTradeConsumer, measureLag } from './consumer';
import { createMessageHandler } from './handler';
import { createWorkerMetrics } from './metrics';

const config = loadConfig(process.env);
const workerId = await resolveInstanceId({ configured: config.instanceId, service: 'worker' });
const logger = createServiceLogger({
  level: config.log.level,
  pretty: config.log.pretty,
  service: 'copy-trade-worker',
  instanceId: workerId,
});
const metrics = createWorkerMetrics({ collectDefaults: true, instanceId: workerId });
const startedAt = new Date();

const db = createDatabase({
  connectionString: config.db.url,
  poolMax: config.db.poolMax,
  applicationName: `copy-trade-worker:${workerId}`,
  statementTimeoutMs: config.db.statementTimeoutMs,
  onIdleClientError: (err) => {
    logger.warn({ err }, 'idle database client error');
  },
});
const registry = new KyselyInstanceRegistry(db);
const copyTrades = new CopyTradeService({
  unitOfWork: new KyselyUnitOfWork(db, { followerLocking: 'for-update' }),
  clock: systemClock,
  ids: uuidGenerator,
  retry: {
    maxAttempts: config.retry.maxAttempts,
    baseDelayMs: config.retry.baseDelayMs,
    sleep: realSleep,
    random: Math.random,
    onRetry: (event) => {
      logger.warn({ event: 'copy_trade.retry', ...event }, 'retrying copy-trade transaction');
    },
  },
});

const kafka = createKafka({
  brokers: config.kafka.brokers,
  clientId: `${config.kafka.clientId}-${workerId}`,
  logger,
});
const admin = kafka.admin();
const producer = createProducer(kafka);
await admin.connect();
await ensureTopics(
  admin,
  { requestedPartitions: config.kafka.requestedPartitions, resultPartitions: 3 },
  { ...TOPICS, requested: config.kafka.requestedTopic },
);
await producer.connect();

const consumer = new CopyTradeConsumer({
  kafka,
  groupId: config.kafka.groupId,
  topic: config.kafka.requestedTopic,
  logger,
  metrics,
  concurrency: config.worker.concurrency,
  sessionTimeoutMs: config.kafka.sessionTimeoutMs,
  heartbeatIntervalMs: config.kafka.heartbeatIntervalMs,
  handler: createMessageHandler({
    copyTrades,
    output: new KafkaWorkerOutput(producer, workerId),
    workerId,
    maxAttempts: config.worker.maxAttempts,
    retryDelayMs: config.worker.retryDelayMs,
    simulatedLatencyMs: config.worker.simulatedLatencyMs,
    sleep: realSleep,
    logger,
    metrics,
  }),
});

const server = createServer((req, res) => {
  void (async () => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      res.end(await metrics.registry.metrics());
    } else if (req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    } else if (req.url === '/health/ready') {
      const ready = consumer.joined;
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: ready ? 'ok' : 'unavailable',
          workerId,
          partitions: consumer.assignedPartitions,
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  })();
});

const tasks: PeriodicTask[] = [];
const heartbeat = () =>
  registry.heartbeat({
    id: workerId,
    kind: 'worker',
    startedAt,
    now: new Date(),
    partitions: consumer.assignedPartitions,
  });
await heartbeat();
if (config.heartbeatIntervalMs > 0) {
  tasks.push(startPeriodicTask('heartbeat', config.heartbeatIntervalMs, heartbeat, logger));
}
if (config.lagIntervalMs > 0) {
  tasks.push(
    startPeriodicTask(
      'consumer-lag',
      config.lagIntervalMs,
      async () => {
        const lag = await measureLag(
          admin,
          config.kafka.groupId,
          config.kafka.requestedTopic,
          consumer.assignedPartitions,
        );
        let total = 0;
        for (const [partition, value] of lag) {
          metrics.lag.set(
            { topic: config.kafka.requestedTopic, partition: String(partition) },
            value,
          );
          total += value;
        }
        metrics.lagTotal.set({ topic: config.kafka.requestedTopic }, total);
      },
      logger,
    ),
  );
}

await consumer.start();
server.listen(config.http.port, config.http.host);
logger.info(
  {
    event: 'worker.started',
    groupId: config.kafka.groupId,
    topic: config.kafka.requestedTopic,
    metricsPort: config.http.port,
  },
  'worker started',
);

closeWithGrace({ delay: 15_000, logger }, async ({ signal, err }) => {
  if (err !== undefined) logger.error({ err }, 'worker shutting down after error');
  else logger.info({ event: 'worker.stopping', signal }, 'worker shutting down, leaving the group');
  await Promise.all(tasks.map((t) => t.stop()));
  await consumer.stop();
  await producer.disconnect();
  await admin.disconnect();
  await registry.markStopped(workerId, new Date()).catch(() => undefined);
  await db.destroy();
  server.close();
  logger.info({ event: 'worker.stopped' }, 'worker stopped');
});
