import {
  reconcileFollower,
  summarizeReconciliation,
  type FollowerReconciliation,
  type ReconciliationSummary,
} from '@copy-trade/domain';
import type { Clock, ReconciliationRepository } from './ports';

export interface ReconciliationReport {
  readonly checkedAt: Date;
  readonly summary: ReconciliationSummary;
  readonly stuckPending: number;
  readonly drifted: readonly FollowerReconciliation[];
}

/** Receives every report; adapters publish gauges and log drift. It must never mutate state. */
export interface ReconciliationObserver {
  onReport(report: ReconciliationReport): void;
}

export interface ReconciliationServiceDeps {
  readonly repository: ReconciliationRepository;
  readonly clock: Clock;
  readonly observer: ReconciliationObserver;
  readonly stuckPendingThresholdMs: number;
}

/**
 * Verifies ledger invariants (balance = opening - held, allocation likewise, one row per key,
 * never negative). Detection only: drift is reported, never silently corrected. Re-driving
 * stuck executions is a separate, explicit operation.
 */
export class ReconciliationService {
  readonly #deps: ReconciliationServiceDeps;

  constructor(deps: ReconciliationServiceDeps) {
    this.#deps = deps;
  }

  async run(): Promise<ReconciliationReport> {
    const { repository, clock, observer } = this.#deps;
    const checkedAt = clock.now();
    const snapshots = await repository.loadSnapshots();
    const results = snapshots.map(reconcileFollower);
    const stuckPending = await repository.countStuckPending(this.#stuckCutoff(checkedAt));

    const report: ReconciliationReport = {
      checkedAt,
      summary: summarizeReconciliation(results),
      stuckPending,
      drifted: results.filter((r) => !r.consistent),
    };
    observer.onReport(report);
    return report;
  }

  redriveStuck(): Promise<number> {
    const now = this.#deps.clock.now();
    return this.#deps.repository.requeueStuckPending(this.#stuckCutoff(now), now);
  }

  #stuckCutoff(now: Date): Date {
    return new Date(now.getTime() - this.#deps.stuckPendingThresholdMs);
  }
}
