import type { ProcessedEvent, ProcessedOutcome, TradeOpenedEvent } from '@copy-trade/application';
import {
  CopyTradeResultEventSchema,
  EVENT_HEADERS,
  TradeOpenedEventSchema,
  type PROCESSED_OUTCOMES,
  type CopyTradeResultEvent,
  type TradeOpenedEventDto,
} from '@copy-trade/contracts';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Compile-time guards: the application event types and the wire contracts cannot drift apart.
export const tradeOpenedInSync: Equal<TradeOpenedEvent, TradeOpenedEventDto> = true;
export const outcomesInSync: Equal<ProcessedOutcome, (typeof PROCESSED_OUTCOMES)[number]> = true;

export type Headers = Record<string, string>;

export function encodeTradeOpened(event: TradeOpenedEvent): { value: string; headers: Headers } {
  return {
    value: JSON.stringify(TradeOpenedEventSchema.parse(event)),
    headers: { [EVENT_HEADERS.eventId]: event.eventId, [EVENT_HEADERS.eventType]: event.type },
  };
}

export type DecodeResult =
  | { readonly ok: true; readonly event: TradeOpenedEvent }
  | { readonly ok: false; readonly error: string };

/** Parses and validates an inbound message value. Invalid messages are never retried. */
export function decodeTradeOpened(value: Buffer | null): DecodeResult {
  if (value === null) return { ok: false, error: 'empty message value' };
  let json: unknown;
  try {
    json = JSON.parse(value.toString('utf8'));
  } catch {
    return { ok: false, error: 'value is not valid JSON' };
  }
  const parsed = TradeOpenedEventSchema.safeParse(json);
  return parsed.success
    ? { ok: true, event: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}

/**
 * Result event for a processed request. Its id is derived from the request event id, so a
 * redelivery republishes an event downstream consumers recognise as the same one.
 */
export function toResultEvent(record: ProcessedEvent, redelivered: boolean): CopyTradeResultEvent {
  return CopyTradeResultEventSchema.parse({
    eventId: `${record.eventId}:result`,
    type: record.outcome === 'rejected' ? 'CopyTradeRejected' : 'CopyTradeCompleted',
    version: 1,
    causationId: record.eventId,
    occurredAt: record.processedAt.toISOString(),
    tradeId: record.tradeId,
    followerId: record.followerId,
    outcome: record.outcome,
    reason: record.reason,
    followerTradeId: record.followerTradeId,
    handledBy: record.handledBy,
    redelivered,
  });
}

/** Kafka header values arrive as Buffer | string | (Buffer | string)[] | undefined. */
export function headerString(
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}
