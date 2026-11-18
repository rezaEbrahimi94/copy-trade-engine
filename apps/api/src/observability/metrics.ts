import type { ReconciliationObserver, ReconciliationReport } from '@copy-trade/application';
import type { Logger } from 'pino';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  readonly registry: Registry;
  readonly httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly copyOutcomes: Counter<'outcome' | 'reason'>;
  readonly txRetries: Counter<'reason'>;
  readonly executions: Counter<'result'>;
  readonly tradesOpened: Counter<'outcome'>;
  readonly eventsPublished: Counter<'result'>;
  readonly reconciliationDriftedFollowers: Gauge;
  readonly reconciliationAbsoluteDrift: Gauge;
  readonly reconciliationDuplicateKeys: Gauge;
  readonly reconciliationStuckPending: Gauge;
  readonly reconciliationLastRun: Gauge;
}

/** A registry per app instance (not the global one) keeps tests isolated. */
export function createMetrics(options: { collectDefaults: boolean; instanceId: string }): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ instance_id: options.instanceId });
  if (options.collectDefaults) collectDefaultMetrics({ register: registry });

  const registers = [registry];
  return {
    registry,
    tradesOpened: new Counter({
      name: 'trades_opened_total',
      help: 'POST /trades outcomes (accepted, duplicate, trade_conflict, invalid_amount)',
      labelNames: ['outcome'],
      registers,
    }),
    eventsPublished: new Counter({
      name: 'event_outbox_published_total',
      help: 'Outbox events published to the bus (result=published) or rescheduled (result=failed)',
      labelNames: ['result'],
      registers,
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration by route and status',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    }),
    copyOutcomes: new Counter({
      name: 'copy_trade_outcomes_total',
      help: 'Copy-trade results by outcome and rejection reason',
      labelNames: ['outcome', 'reason'],
      registers,
    }),
    txRetries: new Counter({
      name: 'copy_trade_transaction_retries_total',
      help: 'Copy-trade transactions retried after a transient failure',
      labelNames: ['reason'],
      registers,
    }),
    executions: new Counter({
      name: 'copy_trade_executions_total',
      help: 'Outbox relay results',
      labelNames: ['result'],
      registers,
    }),
    reconciliationDriftedFollowers: new Gauge({
      name: 'reconciliation_drifted_followers',
      help: 'Followers whose balance/allocation do not match opening minus ledger',
      registers,
    }),
    reconciliationAbsoluteDrift: new Gauge({
      name: 'reconciliation_absolute_drift_minor_units',
      help: 'Sum of absolute balance and allocation drift (minor units)',
      registers,
    }),
    reconciliationDuplicateKeys: new Gauge({
      name: 'reconciliation_duplicate_keys',
      help: 'Ledger keys with more than one row (must be 0)',
      registers,
    }),
    reconciliationStuckPending: new Gauge({
      name: 'reconciliation_stuck_pending',
      help: 'Ledger entries pending longer than the stuck threshold',
      registers,
    }),
    reconciliationLastRun: new Gauge({
      name: 'reconciliation_last_run_timestamp_seconds',
      help: 'Unix time of the last reconciliation run',
      registers,
    }),
  };
}

/** Publishes reconciliation results; drift is logged at error level and never auto-corrected. */
export function createReconciliationObserver(
  metrics: Metrics,
  logger: Logger,
): ReconciliationObserver {
  return {
    onReport(report: ReconciliationReport) {
      metrics.reconciliationDriftedFollowers.set(report.summary.driftedFollowers);
      metrics.reconciliationAbsoluteDrift.set(report.summary.totalAbsoluteDrift);
      metrics.reconciliationDuplicateKeys.set(report.summary.duplicateKeys);
      metrics.reconciliationStuckPending.set(report.stuckPending);
      metrics.reconciliationLastRun.set(report.checkedAt.getTime() / 1000);

      for (const drift of report.drifted) {
        logger.error({ event: 'reconciliation.drift', ...drift }, 'ledger drift detected');
      }
      if (report.stuckPending > 0) {
        logger.warn(
          { event: 'reconciliation.stuck_pending', count: report.stuckPending },
          'pending executions exceeded threshold',
        );
      }
      logger.info({ event: 'reconciliation.completed', ...report.summary }, 'reconciliation run');
    },
  };
}
