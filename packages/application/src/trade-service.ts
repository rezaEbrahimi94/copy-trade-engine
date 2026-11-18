import { isValidAmount, type Trade } from '@copy-trade/domain';
import { InvariantViolationError } from './errors';
import type {
  Clock,
  IdGenerator,
  OutboxEvent,
  TradeReadRepository,
  TradeRecord,
  TradeUnitOfWork,
  TradeView,
} from './ports';
import { withRetry, type RetryPolicy } from './retry';

export interface TradeServiceDeps {
  readonly unitOfWork: TradeUnitOfWork;
  readonly reads: TradeReadRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly retry: RetryPolicy;
  /** Topic the fanned-out `TradeOpened` events are published to. */
  readonly requestedTopic: string;
  readonly listLimit: number;
}

export type OpenTradeResult =
  | {
      readonly outcome: 'accepted' | 'duplicate';
      readonly trade: TradeRecord;
      readonly requestedFollowerIds: readonly string[];
    }
  | { readonly outcome: 'invalid_amount' }
  | { readonly outcome: 'trade_conflict'; readonly trade: TradeRecord };

const sameTrade = (a: Trade, b: Trade): boolean =>
  a.traderId === b.traderId && a.amount === b.amount;

/**
 * Use case: a trader opens a trade. One transaction stores the trade and one `TradeOpened`
 * outbox event per eligible follower; the relay publishes them and workers copy them.
 * Opening the same trade again is idempotent and fans out nothing new.
 */
export class TradeService {
  readonly #deps: TradeServiceDeps;

  constructor(deps: TradeServiceDeps) {
    this.#deps = deps;
  }

  openTrade(trade: Trade): Promise<OpenTradeResult> {
    if (!isValidAmount(trade.amount)) return Promise.resolve({ outcome: 'invalid_amount' });
    const { unitOfWork, clock, ids, requestedTopic } = this.#deps;

    return withRetry(this.#deps.retry, () =>
      unitOfWork.transaction(async (tx): Promise<OpenTradeResult> => {
        const now = clock.now();
        const inserted = await tx.insertTrade({ ...trade, createdAt: now });
        if (inserted === undefined) {
          const existing = await tx.findTrade(trade.id);
          if (existing === undefined) {
            throw new InvariantViolationError(`Trade ${trade.id} conflicted but is missing`);
          }
          if (!sameTrade(existing, trade)) return { outcome: 'trade_conflict', trade: existing };
          const events = await tx.listTradeEvents(trade.id);
          return {
            outcome: 'duplicate',
            trade: existing,
            requestedFollowerIds: events.map((e) => e.payload.followerId),
          };
        }

        const followerIds = await tx.findEligibleSubscribers(trade.traderId);
        for (const followerId of followerIds) {
          const eventId = ids.next();
          await tx.enqueueEvent({
            id: ids.next(),
            eventId,
            topic: requestedTopic,
            key: followerId,
            tradeId: trade.id,
            payload: {
              eventId,
              type: 'TradeOpened',
              version: 1,
              occurredAt: now.toISOString(),
              trade: { id: trade.id, traderId: trade.traderId, amount: trade.amount },
              followerId,
            },
            attempts: 0,
            availableAt: now,
          });
        }
        return { outcome: 'accepted', trade: inserted, requestedFollowerIds: followerIds };
      }),
    );
  }

  /**
   * Operator/demo action: publishes the trade's original events again with the same event
   * ids, i.e. a forced redelivery. Consumers must treat them as already processed.
   */
  republish(tradeId: string): Promise<number | undefined> {
    const { unitOfWork, clock, ids } = this.#deps;
    return unitOfWork.transaction(async (tx) => {
      if ((await tx.findTrade(tradeId)) === undefined) return undefined;
      const events = await tx.listTradeEvents(tradeId);
      const now = clock.now();
      for (const event of events) {
        const copy: OutboxEvent = { ...event, id: ids.next(), attempts: 0, availableAt: now };
        await tx.enqueueEvent(copy);
      }
      return events.length;
    });
  }

  get(tradeId: string): Promise<TradeView | undefined> {
    return this.#deps.reads.findTradeView(tradeId);
  }

  list(): Promise<readonly TradeView[]> {
    return this.#deps.reads.listTradeViews(this.#deps.listLimit);
  }
}
