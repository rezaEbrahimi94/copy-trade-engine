import type { CopyTradeService, ProcessedOutcome, Sleep } from '@copy-trade/application';
import { decodeTradeOpened, type Headers, type WorkerOutput } from '@copy-trade/messaging';
import type { Logger } from 'pino';
import type { WorkerMetrics } from './metrics';

export interface InboundMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: Buffer | null;
  readonly headers: Headers;
}

export type HandleOutcome =
  | {
      readonly kind: 'processed';
      readonly eventId: string;
      readonly outcome: ProcessedOutcome;
      readonly redelivered: boolean;
    }
  | {
      readonly kind: 'dead_lettered';
      readonly reason: 'invalid_payload' | 'processing_failed';
      readonly error: string;
      readonly attempts: number;
    };

export interface HandlerDeps {
  readonly copyTrades: Pick<CopyTradeService, 'processRequestedEvent'>;
  readonly output: WorkerOutput;
  readonly workerId: string;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly simulatedLatencyMs: number;
  readonly sleep: Sleep;
  readonly logger: Logger;
  readonly metrics: WorkerMetrics;
  readonly now?: () => number;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Handles one `copy-trade.requested` message. Resolves when the outcome is durable (DB
 * committed and result or dead letter published); only then may the offset be committed.
 * Rejects only if even the dead letter cannot be published, so the message is redelivered.
 */
export function createMessageHandler(
  deps: HandlerDeps,
): (message: InboundMessage) => Promise<HandleOutcome> {
  const { copyTrades, output, workerId, maxAttempts, retryDelayMs, sleep, metrics } = deps;
  const now = deps.now ?? (() => performance.now());

  const deadLetter = async (
    message: InboundMessage,
    reason: 'invalid_payload' | 'processing_failed',
    error: string,
    attempts: number,
  ): Promise<HandleOutcome> => {
    await output.publishDeadLetter({
      key: message.key,
      value: message.value,
      headers: message.headers,
      reason,
      error,
      attempts,
      source: { topic: message.topic, partition: message.partition, offset: message.offset },
    });
    metrics.deadLettered.inc({ reason });
    deps.logger.error(
      {
        event: 'worker.dead_letter',
        reason,
        error,
        attempts,
        partition: message.partition,
        offset: message.offset,
      },
      'message sent to the dead letter topic',
    );
    return { kind: 'dead_lettered', reason, error, attempts };
  };

  return async (message) => {
    const started = now();
    const decoded = decodeTradeOpened(message.value);
    if (!decoded.ok) return deadLetter(message, 'invalid_payload', decoded.error, 0);
    const { event } = decoded;
    const log = deps.logger.child({
      eventId: event.eventId,
      tradeId: event.trade.id,
      followerId: event.followerId,
      partition: message.partition,
      offset: message.offset,
    });

    for (let attempt = 1; ; attempt++) {
      try {
        if (deps.simulatedLatencyMs > 0) await sleep(deps.simulatedLatencyMs);
        const result = await copyTrades.processRequestedEvent({
          eventId: event.eventId,
          trade: event.trade,
          followerId: event.followerId,
          handledBy: workerId,
          source: { topic: message.topic, partition: message.partition, offset: message.offset },
        });
        await output.publishResult(result.record, result.redelivered);
        const label = result.redelivered ? 'redelivered' : result.record.outcome;
        metrics.processed.inc({ outcome: label });
        metrics.duration.observe({ outcome: label }, (now() - started) / 1000);
        log.info(
          {
            event: 'worker.processed',
            outcome: result.record.outcome,
            reason: result.record.reason,
            redelivered: result.redelivered,
            attempt,
          },
          'copy request processed',
        );
        return {
          kind: 'processed',
          eventId: event.eventId,
          outcome: result.record.outcome,
          redelivered: result.redelivered,
        };
      } catch (error) {
        if (attempt >= maxAttempts) {
          return deadLetter(message, 'processing_failed', describe(error), attempt);
        }
        metrics.retries.inc();
        log.warn({ err: error, attempt, maxAttempts }, 'processing failed, retrying');
        await sleep(retryDelayMs * attempt);
      }
    }
  };
}
