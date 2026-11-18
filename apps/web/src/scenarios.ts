import type { FollowerDto } from '@copy-trade/contracts';
import { api, type CopyTradeCall } from './api';

export interface ScenarioRun {
  readonly id: string;
  readonly name: string;
  readonly follower: FollowerDto;
  readonly calls: readonly CopyTradeCall[];
  readonly summary: string;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly opening: { readonly balance: number; readonly allocation: number };
  run(follower: FollowerDto, newId: () => string): Promise<CopyTradeCall[]>;
}

const TRADER_ID = 'trader-demo';

const trade = (id: string, amount: number) => ({ id, traderId: TRADER_ID, amount });

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'normal',
    name: 'Normal copy',
    description: 'Balance 10,000 / allocation 2,000, one 700 trade',
    opening: { balance: 10_000, allocation: 2_000 },
    run: async (f, newId) => [
      await api.copyTrade({ trade: trade(newId(), 700), followerId: f.id }),
    ],
  },
  {
    id: 'duplicate-sequential',
    name: 'Same trade twice (sequential)',
    description: 'One trade id sent twice, one after the other',
    opening: { balance: 10_000, allocation: 2_000 },
    run: async (f, newId) => {
      const body = { trade: trade(newId(), 700), followerId: f.id };
      return [await api.copyTrade(body), await api.copyTrade(body)];
    },
  },
  {
    id: 'duplicate-concurrent',
    name: 'Same trade twice (concurrent)',
    description: 'One trade id sent twice at the same time',
    opening: { balance: 10_000, allocation: 2_000 },
    run: (f, newId) => {
      const body = { trade: trade(newId(), 700), followerId: f.id };
      return Promise.all([api.copyTrade(body), api.copyTrade(body)]);
    },
  },
  {
    id: 'concurrent-700',
    name: 'Two concurrent 700 trades',
    description: 'Balance 1,000 / allocation 1,000, two different 700 trades at once',
    opening: { balance: 1_000, allocation: 1_000 },
    run: (f, newId) =>
      Promise.all([
        api.copyTrade({ trade: trade(newId(), 700), followerId: f.id }),
        api.copyTrade({ trade: trade(newId(), 700), followerId: f.id }),
      ]),
  },
];

export function summarize(calls: readonly CopyTradeCall[]): string {
  const counts = new Map<string, number>();
  for (const { body } of calls) {
    const label = body.outcome === 'rejected' ? `rejected:${body.reason}` : body.outcome;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${String(n)}× ${k}`)
    .join(', ');
}
