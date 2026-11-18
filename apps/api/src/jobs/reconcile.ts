/**
 * One-shot reconciliation job (cron/K8s CronJob friendly).
 *   pnpm reconcile            -> report only; exit 1 when drift is found
 *   pnpm reconcile --redrive  -> additionally re-queue stuck pending executions
 * It never modifies balances: drift must be investigated by a human.
 */
import { loadConfig } from '../config';
import { createContainer } from '../container';
import { presentReconciliation } from '../http/presenters';
import { createLogger } from '../observability/logger';

const config = loadConfig(process.env);
const logger = createLogger(config, 2);
const container = createContainer(config, logger);

try {
  const report = presentReconciliation(await container.reconciliation.run());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--redrive')) {
    const requeued = await container.reconciliation.redriveStuck();
    logger.warn({ event: 'reconciliation.redrive', requeued }, 'stuck entries re-driven');
  }
  process.exitCode = report.consistent ? 0 : 1;
} finally {
  await container.dispose();
}
