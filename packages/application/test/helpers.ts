import type { Trade } from '@copy-trade/domain';
import { CopyTradeService, type FollowerRecord, type RetryPolicy } from '../src';
import {
  FixedClock,
  immediateRetry,
  InMemoryStore,
  SequentialIds,
  type InMemoryStoreOptions,
} from '../testing';

export const CREATED = new Date('2026-01-01T00:00:00.000Z');

export const followerRecord = (overrides: Partial<FollowerRecord> = {}): FollowerRecord => {
  const balance = overrides.balance ?? 10_000;
  const remainingAllocation = overrides.remainingAllocation ?? 2_000;
  return {
    id: 'follower-1',
    balance,
    remainingAllocation,
    openingBalance: balance,
    openingAllocation: remainingAllocation,
    copyingEnabled: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
};

export const trade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 'trade-1',
  traderId: 'trader-1',
  amount: 700,
  ...overrides,
});

export function setup(
  options: InMemoryStoreOptions & {
    retry?: Partial<RetryPolicy>;
    followers?: FollowerRecord[];
  } = {},
) {
  const store = new InMemoryStore(options);
  for (const f of options.followers ?? [followerRecord()]) store.followers.set(f.id, f);
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const service = new CopyTradeService({
    unitOfWork: store,
    clock,
    ids,
    retry: immediateRetry(options.retry),
  });
  return { store, clock, ids, service };
}
