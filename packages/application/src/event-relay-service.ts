import type { Clock, EventPublisher, EventRelayUnitOfWork } from './ports';

export interface EventRelayServiceDeps {
  readonly unitOfWork: EventRelayUnitOfWork;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
  readonly batchSize: number;
  readonly retryDelayMs: number;
}

export type RelayBatchResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'published'; readonly count: number }
  | { readonly kind: 'failed'; readonly count: number; readonly error: string };

/**
 * Transactional outbox relay: claims a batch with SKIP LOCKED (many relays can run), publishes
 * it, and marks it published in the same transaction. A crash after publishing re-publishes
 * the batch (at-least-once); consumers dedupe on the event id.
 */
export class EventRelayService {
  readonly #deps: EventRelayServiceDeps;

  constructor(deps: EventRelayServiceDeps) {
    this.#deps = deps;
  }

  publishBatch(): Promise<RelayBatchResult> {
    const { unitOfWork, publisher, clock, batchSize, retryDelayMs } = this.#deps;
    return unitOfWork.transaction(async (tx): Promise<RelayBatchResult> => {
      const now = clock.now();
      const events = await tx.claimDueEvents(now, batchSize);
      if (events.length === 0) return { kind: 'idle' };
      try {
        await publisher.publish(events);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const event of events) {
          const attempts = event.attempts + 1;
          const availableAt = new Date(now.getTime() + retryDelayMs * attempts);
          await tx.rescheduleEvent(event.id, attempts, availableAt, message);
        }
        return { kind: 'failed', count: events.length, error: message };
      }
      await tx.markPublished(
        events.map((e) => e.id),
        now,
      );
      return { kind: 'published', count: events.length };
    });
  }

  /** Publishes batches until the outbox is empty, a batch fails, or `maxBatches` is reached. */
  async drain(maxBatches: number): Promise<number> {
    let published = 0;
    for (let i = 0; i < maxBatches; i++) {
      const result = await this.publishBatch();
      if (result.kind !== 'published') break;
      published += result.count;
    }
    return published;
  }
}
