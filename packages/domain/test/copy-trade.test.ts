import { describe, expect, it } from 'vitest';
import {
  decideCopyTrade,
  refundCopyTrade,
  type Follower,
  type RejectionReason,
  type Trade,
} from '../src';

const follower = (overrides: Partial<Follower> = {}): Follower => ({
  id: 'follower-1',
  balance: 10_000,
  remainingAllocation: 2_000,
  copyingEnabled: true,
  ...overrides,
});

const trade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 'trade-1',
  traderId: 'trader-1',
  amount: 700,
  ...overrides,
});

const rejection = (t: Trade, f: Follower | undefined): RejectionReason | undefined => {
  const result = decideCopyTrade(t, f);
  return result.ok ? undefined : result.error;
};

describe('decideCopyTrade', () => {
  it('scenario 1: 10,000 balance / 2,000 allocation copies a 700 trade', () => {
    const result = decideCopyTrade(trade(), follower());

    expect(result).toEqual({
      ok: true,
      value: {
        amount: 700,
        follower: {
          id: 'follower-1',
          balance: 9_300,
          remainingAllocation: 1_300,
          copyingEnabled: true,
        },
      },
    });
  });

  it('does not mutate the input follower', () => {
    const input = follower();
    decideCopyTrade(trade(), input);
    expect(input.balance).toBe(10_000);
    expect(input.remainingAllocation).toBe(2_000);
  });

  it('allows a trade that exactly exhausts balance and allocation', () => {
    const result = decideCopyTrade(
      trade({ amount: 1_000 }),
      follower({ balance: 1_000, remainingAllocation: 1_000 }),
    );
    expect(result.ok && result.value.follower).toMatchObject({
      balance: 0,
      remainingAllocation: 0,
    });
  });

  it.each<[string, Trade, Follower | undefined, RejectionReason]>([
    ['unknown follower', trade(), undefined, 'FOLLOWER_NOT_FOUND'],
    ['zero amount', trade({ amount: 0 }), follower(), 'INVALID_AMOUNT'],
    ['negative amount', trade({ amount: -700 }), follower(), 'INVALID_AMOUNT'],
    ['fractional amount', trade({ amount: 700.5 }), follower(), 'INVALID_AMOUNT'],
    ['unsafe integer amount', trade({ amount: 2 ** 53 }), follower(), 'INVALID_AMOUNT'],
    ['NaN amount', trade({ amount: Number.NaN }), follower(), 'INVALID_AMOUNT'],
    ['self copy', trade({ traderId: 'follower-1' }), follower(), 'SELF_COPY'],
    ['copying disabled', trade(), follower({ copyingEnabled: false }), 'COPYING_DISABLED'],
    ['balance too low', trade(), follower({ balance: 699 }), 'INSUFFICIENT_BALANCE'],
    [
      'allocation too low',
      trade(),
      follower({ remainingAllocation: 699 }),
      'INSUFFICIENT_ALLOCATION',
    ],
  ])('rejects %s', (_name, t, f, reason) => {
    expect(rejection(t, f)).toBe(reason);
  });

  it('orders checks: invalid amount before self copy before disabled before funds', () => {
    const everythingWrong = follower({ copyingEnabled: false, balance: 0, remainingAllocation: 0 });
    expect(rejection(trade({ amount: 0, traderId: 'follower-1' }), everythingWrong)).toBe(
      'INVALID_AMOUNT',
    );
    expect(rejection(trade({ traderId: 'follower-1' }), everythingWrong)).toBe('SELF_COPY');
    expect(rejection(trade(), everythingWrong)).toBe('COPYING_DISABLED');
    expect(rejection(trade(), follower({ balance: 0, remainingAllocation: 0 }))).toBe(
      'INSUFFICIENT_BALANCE',
    );
  });
});

describe('refundCopyTrade', () => {
  it('adds the amount back to balance and allocation', () => {
    expect(refundCopyTrade(follower({ balance: 300, remainingAllocation: 300 }), 700)).toEqual(
      follower({ balance: 1_000, remainingAllocation: 1_000 }),
    );
  });
});
