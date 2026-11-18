import type { ExecutionGateway, ExecutionResult } from '@copy-trade/application';
import type { FollowerTrade } from '@copy-trade/domain';

/**
 * Stand-in for a broker. Deterministic: trades whose id starts with `failureTradePrefix`
 * are rejected, everything else executes. Lets the UI and tests exercise compensation.
 */
export class SimulatedExecutionGateway implements ExecutionGateway {
  readonly #failureTradePrefix: string;

  constructor(failureTradePrefix: string) {
    this.#failureTradePrefix = failureTradePrefix;
  }

  execute(entry: FollowerTrade): Promise<ExecutionResult> {
    return Promise.resolve(
      entry.tradeId.startsWith(this.#failureTradePrefix)
        ? { status: 'failed', error: 'simulated broker rejection' }
        : { status: 'executed' },
    );
  }
}
