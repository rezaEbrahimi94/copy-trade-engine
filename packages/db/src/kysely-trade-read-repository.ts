import type { TradeReadRepository, TradeView } from '@copy-trade/application';
import { sql, type Kysely } from 'kysely';
import { toOutboxEvent, toProcessedEvent } from './mappers';
import type { Database, ProcessedEventRow, TradeRow } from './schema';

/** Read model for the event-driven flow: trade -> fanned-out requests -> inbox outcomes. */
export class KyselyTradeReadRepository implements TradeReadRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async findTradeView(id: string): Promise<TradeView | undefined> {
    const [view] = await this.#views(
      await this.#db.selectFrom('trades').selectAll().where('id', '=', id).execute(),
    );
    return view;
  }

  async listTradeViews(limit: number): Promise<readonly TradeView[]> {
    const trades = await this.#db
      .selectFrom('trades')
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(limit)
      .execute();
    return this.#views(trades);
  }

  async #views(trades: readonly TradeRow[]): Promise<TradeView[]> {
    if (trades.length === 0) return [];
    const tradeIds = trades.map((t) => t.id);
    const events = await this.#db
      .selectFrom('event_outbox')
      .selectAll()
      .select(
        sql<Date | null>`min(published_at) over (partition by event_id)`.as('first_published_at'),
      )
      .where('trade_id', 'in', tradeIds)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const processed = await this.#db
      .selectFrom('processed_events')
      .selectAll()
      .where('trade_id', 'in', tradeIds)
      .execute();
    const byEventId = new Map<string, ProcessedEventRow>(processed.map((p) => [p.event_id, p]));

    return trades.map((t) => {
      const seen = new Set<string>();
      const requests = events
        .filter((e) => e.trade_id === t.id && !seen.has(e.event_id) && seen.add(e.event_id))
        .map((e) => {
          const p = byEventId.get(e.event_id);
          return {
            eventId: e.event_id,
            followerId: toOutboxEvent(e).payload.followerId,
            publishedAt: e.first_published_at,
            processed: p === undefined ? null : toProcessedEvent(p),
          };
        });
      return {
        trade: { id: t.id, traderId: t.trader_id, amount: t.amount, createdAt: t.created_at },
        requests,
      };
    });
  }
}
