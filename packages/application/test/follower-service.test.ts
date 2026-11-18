import { describe, expect, it } from 'vitest';
import { FollowerService } from '../src';
import { FixedClock, InMemoryStore, SequentialIds } from '../testing';

const setup = () => {
  const store = new InMemoryStore();
  const clock = new FixedClock();
  const service = new FollowerService({
    followers: store,
    clock,
    ids: new SequentialIds('f'),
    listLimit: 2,
  });
  return { store, clock, service };
};

describe('FollowerService', () => {
  it('creates a follower whose opening amounts equal the initial ones', async () => {
    const { service } = setup();
    const result = await service.create({
      balance: 10_000,
      allocation: 2_000,
      copyingEnabled: true,
    });
    expect(result).toEqual({
      ok: true,
      follower: {
        id: 'f-000001',
        balance: 10_000,
        remainingAllocation: 2_000,
        openingBalance: 10_000,
        openingAllocation: 2_000,
        copyingEnabled: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  });

  it.each([
    [{ balance: -1, allocation: 0 }, 'INVALID_BALANCE'],
    [{ balance: 1.5, allocation: 0 }, 'INVALID_BALANCE'],
    [{ balance: 0, allocation: -1 }, 'INVALID_ALLOCATION'],
  ] as const)('rejects invalid amounts %o', async (amounts, reason) => {
    const { service, store } = setup();
    expect(await service.create({ ...amounts, copyingEnabled: true })).toEqual({
      ok: false,
      reason,
    });
    expect(store.followers.size).toBe(0);
  });

  it('gets, lists (bounded) and toggles copying', async () => {
    const { service, clock } = setup();
    for (let i = 0; i < 3; i++)
      await service.create({ balance: 1, allocation: 1, copyingEnabled: true });

    expect(await service.get('f-000002')).toMatchObject({ id: 'f-000002' });
    expect(await service.get('nope')).toBeUndefined();
    expect(await service.list()).toHaveLength(2);

    clock.advance(1_000);
    expect(await service.setCopyingEnabled('f-000001', false)).toMatchObject({
      copyingEnabled: false,
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    expect(await service.setCopyingEnabled('nope', false)).toBeUndefined();
  });

  it('lists trades for an existing follower and returns undefined for an unknown one', async () => {
    const { service } = setup();
    await service.create({ balance: 1, allocation: 1, copyingEnabled: true });
    expect(await service.listTrades('f-000001')).toEqual([]);
    expect(await service.listTrades('nope')).toBeUndefined();
  });
});
