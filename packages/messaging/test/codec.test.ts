import type { ProcessedEvent } from '@copy-trade/application';
import { describe, expect, it } from 'vitest';
import { decodeTradeOpened, encodeTradeOpened, headerString, toResultEvent } from '../src';

const event = {
  eventId: 'evt-1',
  type: 'TradeOpened' as const,
  version: 1 as const,
  occurredAt: '2026-01-01T00:00:00.000Z',
  trade: { id: 't1', traderId: 'trader', amount: 700 },
  followerId: 'f1',
};

const record: ProcessedEvent = {
  eventId: 'evt-1',
  tradeId: 't1',
  followerId: 'f1',
  outcome: 'rejected',
  reason: 'INSUFFICIENT_BALANCE',
  followerTradeId: null,
  handledBy: 'worker-2',
  source: null,
  processedAt: new Date('2026-01-01T00:00:01.000Z'),
};

describe('event codec', () => {
  it('round-trips TradeOpened with id and type headers', () => {
    const { value, headers } = encodeTradeOpened(event);
    expect(headers).toEqual({ 'event-id': 'evt-1', 'event-type': 'TradeOpened' });
    expect(decodeTradeOpened(Buffer.from(value))).toEqual({ ok: true, event });
  });

  it.each([
    [null, 'empty message value'],
    [Buffer.from('{nope'), 'value is not valid JSON'],
    [Buffer.from(JSON.stringify({ ...event, followerId: '' })), 'followerId:'],
    [Buffer.from(JSON.stringify({ ...event, extra: 1 })), 'Unrecognized key'],
  ])('rejects invalid values (%#)', (value, error) => {
    const decoded = decodeTradeOpened(value);
    expect(decoded.ok).toBe(false);
    expect(decoded.ok ? '' : decoded.error).toContain(error);
  });

  it('derives result events deterministically from the inbox record', () => {
    expect(toResultEvent(record, true)).toEqual({
      eventId: 'evt-1:result',
      type: 'CopyTradeRejected',
      version: 1,
      causationId: 'evt-1',
      occurredAt: '2026-01-01T00:00:01.000Z',
      tradeId: 't1',
      followerId: 'f1',
      outcome: 'rejected',
      reason: 'INSUFFICIENT_BALANCE',
      followerTradeId: null,
      handledBy: 'worker-2',
      redelivered: true,
    });
    expect(
      toResultEvent({ ...record, outcome: 'copied', reason: null, followerTradeId: 'ft' }, false),
    ).toMatchObject({ type: 'CopyTradeCompleted', redelivered: false });
  });

  it('reads Kafka header values of every shape', () => {
    expect(headerString(Buffer.from('a'))).toBe('a');
    expect(headerString('b')).toBe('b');
    expect(headerString([Buffer.from('c'), 'd'])).toBe('c');
    expect(headerString(undefined)).toBeUndefined();
    expect(headerString([])).toBeUndefined();
  });
});
