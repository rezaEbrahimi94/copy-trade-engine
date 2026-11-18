import type { FollowerTrade } from '@copy-trade/domain';
import type { Clock, ExecutionGateway, ExecutionResult, IdGenerator } from '../src/ports';
import type { RetryPolicy } from '../src/retry';

export class FixedClock implements Clock {
  #now: Date;

  constructor(iso = '2026-01-01T00:00:00.000Z') {
    this.#now = new Date(iso);
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  #next = 0;
  readonly #prefix: string;

  constructor(prefix = 'id') {
    this.#prefix = prefix;
  }

  next(): string {
    this.#next += 1;
    return `${this.#prefix}-${String(this.#next).padStart(6, '0')}`;
  }
}

export const immediateRetry = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 5,
  baseDelayMs: 10,
  sleep: () => Promise.resolve(),
  random: () => 0.5,
  ...overrides,
});

export class ScriptedGateway implements ExecutionGateway {
  readonly calls: FollowerTrade[] = [];
  readonly #script: (entry: FollowerTrade, call: number) => ExecutionResult;

  constructor(script: (entry: FollowerTrade, call: number) => ExecutionResult) {
    this.#script = script;
  }

  execute(entry: FollowerTrade): Promise<ExecutionResult> {
    this.calls.push(entry);
    return Promise.resolve(this.#script(entry, this.calls.length));
  }
}
