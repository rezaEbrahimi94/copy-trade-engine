import type {
  CopyTradeService,
  FollowerService,
  IdGenerator,
  ReconciliationService,
} from '@copy-trade/application';
import type { Logger } from 'pino';
import type { Metrics } from '../observability/metrics';

/** Everything the HTTP layer needs, injected by the composition root (or a test). */
export interface AppDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly ids: IdGenerator;
  readonly copyTrades: CopyTradeService;
  readonly followers: FollowerService;
  readonly reconciliation: ReconciliationService;
  /** Named dependency checks for /health/ready; each resolves true when healthy. */
  readonly readinessChecks: Readonly<Record<string, () => Promise<boolean>>>;
  readonly corsOrigin: string;
}
