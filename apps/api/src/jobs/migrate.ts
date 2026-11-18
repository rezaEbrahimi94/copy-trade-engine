import { createDatabase, migrateToLatest } from '@copy-trade/db';
import { loadConfig } from '../config';
import { createLogger } from '../observability/logger';

const config = loadConfig(process.env);
const logger = createLogger(config);
const db = createDatabase({
  connectionString: config.db.url,
  poolMax: 1,
  applicationName: `${config.otel.serviceName}:migrate`,
  statementTimeoutMs: config.db.statementTimeoutMs,
});

try {
  const { results } = await migrateToLatest(db);
  for (const r of results ?? []) logger.info({ migration: r.migrationName, status: r.status });
  logger.info('database is at latest migration');
} finally {
  await db.destroy();
}
