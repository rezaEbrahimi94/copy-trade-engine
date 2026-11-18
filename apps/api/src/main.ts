import { migrateToLatest } from '@copy-trade/db';
import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config';
import { createContainer } from './container';
import { buildApp } from './http/app';
import { startPeriodicTask, type PeriodicTask } from './infrastructure/periodic-task';
import { createLogger } from './observability/logger';

const config = loadConfig(process.env);
const logger = createLogger(config);
const container = createContainer(config, logger);

if (config.db.migrateOnStart) {
  const { results } = await migrateToLatest(container.db);
  logger.info({ migrations: results?.map((r) => `${r.migrationName}:${r.status}`) }, 'migrated');
}

const app = await buildApp(container);
const tasks: PeriodicTask[] = [];

if (config.outbox.pollIntervalMs > 0) {
  tasks.push(
    startPeriodicTask(
      'outbox-relay',
      config.outbox.pollIntervalMs,
      async () => {
        const steps = await container.execution.drain(config.outbox.batchSize);
        for (const step of steps) container.metrics.executions.inc({ result: step.kind });
      },
      logger,
    ),
  );
}
if (config.reconciliation.intervalMs > 0) {
  tasks.push(
    startPeriodicTask(
      'reconciliation',
      config.reconciliation.intervalMs,
      async () => {
        await container.reconciliation.run();
      },
      logger,
    ),
  );
}

closeWithGrace({ delay: 10_000, logger }, async ({ signal, err }) => {
  if (err !== undefined) logger.error({ err }, 'shutting down after error');
  else logger.info({ signal }, 'shutting down');
  await Promise.all(tasks.map((t) => t.stop()));
  await app.close();
  await container.dispose();
});

await app.listen({ host: config.http.host, port: config.http.port });
