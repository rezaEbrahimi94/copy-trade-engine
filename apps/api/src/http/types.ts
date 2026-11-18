import type {
  CopyTradeService,
  FollowerService,
  IdGenerator,
  ReconciliationService,
  TradeService,
} from '@copy-trade/application';
import type { SystemInfo } from '@copy-trade/contracts';
import type { InstanceStatus } from '@copy-trade/db';
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
  readonly trades: TradeService;
  /** Replica identity, returned in the `x-instance-id` header of every response. */
  readonly instanceId: string;
  readonly instances: { list(): Promise<readonly InstanceStatus[]> };
  readonly system: SystemInfo;
  /** Named dependency checks for /health/ready; each resolves true when healthy. */
  readonly readinessChecks: Readonly<Record<string, () => Promise<boolean>>>;
  readonly corsOrigin: string;
}
