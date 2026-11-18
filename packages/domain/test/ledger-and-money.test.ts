import { describe, expect, it } from 'vitest';
import { err, holdsFunds, isValidAmount, isValidBalance, ok, transitionStatus } from '../src';

describe('money', () => {
  it.each([
    [1, true],
    [700, true],
    [Number.MAX_SAFE_INTEGER, true],
    [0, false],
    [-1, false],
    [0.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    [Number.POSITIVE_INFINITY, false],
  ])('isValidAmount(%s) = %s', (value, expected) => {
    expect(isValidAmount(value)).toBe(expected);
  });

  it.each([
    [0, true],
    [10_000, true],
    [-1, false],
    [1.5, false],
  ])('isValidBalance(%s) = %s', (value, expected) => {
    expect(isValidBalance(value)).toBe(expected);
  });
});

describe('ledger status', () => {
  it('only pending entries can settle', () => {
    expect(transitionStatus('pending', 'executed')).toEqual(ok('executed'));
    expect(transitionStatus('pending', 'failed')).toEqual(ok('failed'));
    expect(transitionStatus('executed', 'failed')).toEqual(err({ from: 'executed', to: 'failed' }));
    expect(transitionStatus('failed', 'executed')).toEqual(err({ from: 'failed', to: 'executed' }));
  });

  it('failed (compensated) entries no longer hold funds', () => {
    expect(holdsFunds('pending')).toBe(true);
    expect(holdsFunds('executed')).toBe(true);
    expect(holdsFunds('failed')).toBe(false);
  });
});
