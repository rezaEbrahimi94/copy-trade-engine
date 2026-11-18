import {
  holdsFunds,
  type Follower,
  type FollowerLedgerSnapshot,
  type FollowerTrade,
  type FollowerTradeStatus,
} from '@copy-trade/domain';
import { TransientTransactionError } from '../src/errors';
import type {
  CopyTradeTransaction,
  CopyTradeUnitOfWork,
  EventRelayTransaction,
  EventRelayUnitOfWork,
  ExecutionTransaction,
  ExecutionUnitOfWork,
  FollowerRecord,
  FollowerRepository,
  FollowerView,
  OutboxEvent,
  OutboxMessage,
  ProcessedEvent,
  ReconciliationRepository,
  TradeReadRepository,
  TradeRecord,
  TradeTransaction,
  TradeUnitOfWork,
  TradeView,
} from '../src/ports';
import { KeyedMutex, type Release } from './keyed-mutex';

interface StoredMessage extends OutboxMessage {
  readonly processedAt: Date | null;
  readonly lastError: string | null;
}

export interface StoredEvent extends OutboxEvent {
  readonly publishedAt: Date | null;
  readonly lastError: string | null;
}

type AnyTransaction = CopyTradeTransaction &
  ExecutionTransaction &
  TradeTransaction &
  EventRelayTransaction;

export interface InMemoryStoreOptions {
  /** `false` disables follower row locks: the negative control for concurrency tests. */
  readonly rowLocking?: boolean;
  /** Awaited between storage operations so tests can force interleavings. */
  readonly yieldPoint?: () => Promise<void>;
}

const tradeKey = (tradeId: string, followerId: string): string => `${tradeId}\u0000${followerId}`;

/**
 * Transactional in-memory adapter for every application port. Writes are recorded in an
 * undo log and reverted when the unit of work throws, mirroring a database rollback.
 */
export class InMemoryStore
  implements
    CopyTradeUnitOfWork,
    ExecutionUnitOfWork,
    TradeUnitOfWork,
    EventRelayUnitOfWork,
    FollowerRepository,
    ReconciliationRepository,
    TradeReadRepository
{
  readonly followers = new Map<string, FollowerRecord>();
  readonly trades = new Map<string, FollowerTrade>();
  readonly outbox = new Map<string, StoredMessage>();
  /** followerId -> traders it copies. */
  readonly subscriptions = new Map<string, readonly string[]>();
  readonly openedTrades = new Map<string, TradeRecord>();
  readonly events = new Map<string, StoredEvent>();
  readonly processedEvents = new Map<string, ProcessedEvent>();
  readonly #mutex = new KeyedMutex();
  readonly #rowLocking: boolean;
  readonly #yield: () => Promise<void>;
  #pendingFailures: string[] = [];

  constructor(options: InMemoryStoreOptions = {}) {
    this.#rowLocking = options.rowLocking ?? true;
    this.#yield = options.yieldPoint ?? (() => Promise.resolve());
  }

  /** Makes the next N transactions fail at commit with the given SQLSTATE codes. */
  failNextCommits(...codes: string[]): void {
    this.#pendingFailures.push(...codes);
  }

  async transaction<T>(work: (tx: AnyTransaction) => Promise<T>) {
    const undo: (() => void)[] = [];
    const releases: Release[] = [];
    const held = new Set<string>();
    const lock = async (key: string): Promise<void> => {
      if (held.has(key)) return;
      releases.push(await this.#mutex.acquire(key));
      held.add(key);
    };
    try {
      const result = await work(this.#transactionApi(undo, lock, releases, held));
      const failure = this.#pendingFailures.shift();
      if (failure !== undefined) throw new TransientTransactionError(failure);
      return result;
    } catch (error) {
      for (const revert of undo.reverse()) revert();
      throw error;
    } finally {
      for (const release of releases) release();
    }
  }

  #transactionApi(
    undo: (() => void)[],
    lock: (key: string) => Promise<void>,
    releases: Release[],
    held: Set<string>,
  ): AnyTransaction {
    const setMap = <V>(map: Map<string, V>, key: string, value: V): void => {
      const before = map.get(key);
      undo.push(() => (before === undefined ? map.delete(key) : map.set(key, before)));
      map.set(key, value);
    };

    return {
      lockFollower: async (followerId) => {
        await this.#yield();
        if (this.#rowLocking) await lock(`follower:${followerId}`);
        return this.followers.get(followerId);
      },
      findFollowerTrade: async (tradeId, followerId) => {
        await this.#yield();
        return this.trades.get(tradeKey(tradeId, followerId));
      },
      findFollowerTradeByIdempotencyKey: async (key) => {
        await this.#yield();
        return [...this.trades.values()].find((t) => t.idempotencyKey === key);
      },
      saveFollowerBalances: async (follower: Follower, now) => {
        await this.#yield();
        const current = this.followers.get(follower.id);
        if (current === undefined) return;
        if (follower.balance < 0 || follower.remainingAllocation < 0) {
          throw new Error('check constraint violation: negative balance');
        }
        setMap(this.followers, follower.id, {
          ...current,
          balance: follower.balance,
          remainingAllocation: follower.remainingAllocation,
          updatedAt: now,
        });
      },
      insertFollowerTrade: async (entry) => {
        await this.#yield();
        const key = tradeKey(entry.tradeId, entry.followerId);
        const keyTaken =
          entry.idempotencyKey !== null &&
          [...this.trades.values()].some((t) => t.idempotencyKey === entry.idempotencyKey);
        if (this.trades.has(key) || keyTaken) return undefined;
        setMap(this.trades, key, entry);
        return entry;
      },
      enqueueExecution: async (message) => {
        await this.#yield();
        setMap(this.outbox, message.id, { ...message, processedAt: null, lastError: null });
      },
      claimNextDue: async (now) => {
        await this.#yield();
        const due = [...this.outbox.values()]
          .filter((m) => m.processedAt === null && m.availableAt.getTime() <= now.getTime())
          .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
        for (const message of due) {
          const key = `outbox:${message.id}`;
          if (held.has(key)) return message;
          const release = this.#mutex.tryAcquire(key);
          if (release === undefined) continue;
          releases.push(release);
          held.add(key);
          return message;
        }
        return undefined;
      },
      getFollowerTrade: async (id) => {
        await this.#yield();
        return [...this.trades.values()].find((t) => t.id === id);
      },
      settleFollowerTrade: async (id, status: FollowerTradeStatus, now) => {
        await this.#yield();
        const entry = [...this.trades.values()].find((t) => t.id === id);
        if (entry?.status !== 'pending') return false;
        setMap(this.trades, tradeKey(entry.tradeId, entry.followerId), {
          ...entry,
          status,
          updatedAt: now,
        });
        return true;
      },
      completeMessage: async (id, now) => {
        await this.#yield();
        const message = this.outbox.get(id);
        if (message !== undefined) setMap(this.outbox, id, { ...message, processedAt: now });
      },
      rescheduleMessage: async (id, attempts, availableAt, error) => {
        await this.#yield();
        const message = this.outbox.get(id);
        if (message !== undefined) {
          setMap(this.outbox, id, { ...message, attempts, availableAt, lastError: error });
        }
      },
      findProcessedEvent: async (eventId) => {
        await this.#yield();
        return this.processedEvents.get(eventId);
      },
      recordProcessedEvent: async (record) => {
        await this.#yield();
        if (this.processedEvents.has(record.eventId)) return false;
        setMap(this.processedEvents, record.eventId, record);
        return true;
      },
      insertTrade: async (trade) => {
        await this.#yield();
        if (this.openedTrades.has(trade.id)) return undefined;
        setMap(this.openedTrades, trade.id, trade);
        return trade;
      },
      findTrade: async (id) => {
        await this.#yield();
        return this.openedTrades.get(id);
      },
      findEligibleSubscribers: async (traderId) => {
        await this.#yield();
        return [...this.followers.values()]
          .filter(
            (f) =>
              f.copyingEnabled &&
              f.id !== traderId &&
              (this.subscriptions.get(f.id) ?? []).includes(traderId),
          )
          .map((f) => f.id);
      },
      enqueueEvent: async (event) => {
        await this.#yield();
        setMap(this.events, event.id, { ...event, publishedAt: null, lastError: null });
      },
      listTradeEvents: async (tradeId) => {
        await this.#yield();
        return this.#firstEvents(tradeId);
      },
      claimDueEvents: async (now, limit) => {
        await this.#yield();
        const claimed: OutboxEvent[] = [];
        const due = [...this.events.values()].filter(
          (e) => e.publishedAt === null && e.availableAt.getTime() <= now.getTime(),
        );
        for (const event of due) {
          if (claimed.length >= limit) break;
          const release = this.#mutex.tryAcquire(`event:${event.id}`);
          if (release === undefined) continue;
          releases.push(release);
          claimed.push(event);
        }
        return claimed;
      },
      markPublished: async (ids, now) => {
        await this.#yield();
        for (const id of ids) {
          const event = this.events.get(id);
          if (event !== undefined) setMap(this.events, id, { ...event, publishedAt: now });
        }
      },
      rescheduleEvent: async (id, attempts, availableAt, error) => {
        await this.#yield();
        const event = this.events.get(id);
        if (event !== undefined) {
          setMap(this.events, id, { ...event, attempts, availableAt, lastError: error });
        }
      },
    };
  }

  #view(record: FollowerRecord): FollowerView {
    return { ...record, traderIds: this.subscriptions.get(record.id) ?? [] };
  }

  create(record: FollowerRecord, traderIds: readonly string[]): Promise<FollowerView> {
    this.followers.set(record.id, record);
    this.subscriptions.set(record.id, traderIds);
    return Promise.resolve(this.#view(record));
  }

  findById(id: string): Promise<FollowerView | undefined> {
    const record = this.followers.get(id);
    return Promise.resolve(record && this.#view(record));
  }

  list(limit: number): Promise<readonly FollowerView[]> {
    return Promise.resolve([...this.followers.values()].slice(0, limit).map((f) => this.#view(f)));
  }

  setCopyingEnabled(id: string, enabled: boolean, now: Date): Promise<FollowerView | undefined> {
    const current = this.followers.get(id);
    if (current === undefined) return Promise.resolve(undefined);
    const updated = { ...current, copyingEnabled: enabled, updatedAt: now };
    this.followers.set(id, updated);
    return Promise.resolve(this.#view(updated));
  }

  #firstEvents(tradeId: string): StoredEvent[] {
    const byEventId = new Map<string, StoredEvent>();
    for (const e of this.events.values()) {
      if (e.tradeId === tradeId && !byEventId.has(e.eventId)) byEventId.set(e.eventId, e);
    }
    return [...byEventId.values()];
  }

  #tradeView(trade: TradeRecord): TradeView {
    return {
      trade,
      requests: this.#firstEvents(trade.id).map((e) => ({
        eventId: e.eventId,
        followerId: e.payload.followerId,
        publishedAt:
          [...this.events.values()].find((x) => x.eventId === e.eventId && x.publishedAt !== null)
            ?.publishedAt ?? null,
        processed: this.processedEvents.get(e.eventId) ?? null,
      })),
    };
  }

  findTradeView(id: string): Promise<TradeView | undefined> {
    const trade = this.openedTrades.get(id);
    return Promise.resolve(trade && this.#tradeView(trade));
  }

  listTradeViews(limit: number): Promise<readonly TradeView[]> {
    return Promise.resolve(
      [...this.openedTrades.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((t) => this.#tradeView(t)),
    );
  }

  listTrades(followerId: string, limit: number): Promise<readonly FollowerTrade[]> {
    return Promise.resolve(
      [...this.trades.values()].filter((t) => t.followerId === followerId).slice(0, limit),
    );
  }

  loadSnapshots(): Promise<readonly FollowerLedgerSnapshot[]> {
    return Promise.resolve(
      [...this.followers.values()].map((f) => {
        const entries = [...this.trades.values()].filter((t) => t.followerId === f.id);
        const keys = new Map<string, number>();
        for (const t of entries) keys.set(t.tradeId, (keys.get(t.tradeId) ?? 0) + 1);
        return {
          followerId: f.id,
          openingBalance: f.openingBalance,
          openingAllocation: f.openingAllocation,
          balance: f.balance,
          remainingAllocation: f.remainingAllocation,
          heldAmount: entries.filter((t) => holdsFunds(t.status)).reduce((s, t) => s + t.amount, 0),
          duplicateKeyCount: [...keys.values()].filter((n) => n > 1).length,
        };
      }),
    );
  }

  countStuckPending(olderThan: Date): Promise<number> {
    return Promise.resolve(this.#stuck(olderThan).length);
  }

  requeueStuckPending(olderThan: Date, now: Date): Promise<number> {
    const stuck = this.#stuck(olderThan);
    for (const entry of stuck) {
      const message = [...this.outbox.values()].find((m) => m.followerTradeId === entry.id);
      const id = message?.id ?? `redrive-${entry.id}`;
      this.outbox.set(id, {
        id,
        followerTradeId: entry.id,
        attempts: message?.attempts ?? 0,
        availableAt: now,
        processedAt: null,
        lastError: message?.lastError ?? null,
      });
    }
    return Promise.resolve(stuck.length);
  }

  #stuck(olderThan: Date): FollowerTrade[] {
    return [...this.trades.values()].filter(
      (t) => t.status === 'pending' && t.createdAt.getTime() < olderThan.getTime(),
    );
  }
}
