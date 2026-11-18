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
  ExecutionTransaction,
  ExecutionUnitOfWork,
  FollowerRecord,
  FollowerRepository,
  OutboxMessage,
  ReconciliationRepository,
} from '../src/ports';
import { KeyedMutex, type Release } from './keyed-mutex';

interface StoredMessage extends OutboxMessage {
  readonly processedAt: Date | null;
  readonly lastError: string | null;
}

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
  implements CopyTradeUnitOfWork, ExecutionUnitOfWork, FollowerRepository, ReconciliationRepository
{
  readonly followers = new Map<string, FollowerRecord>();
  readonly trades = new Map<string, FollowerTrade>();
  readonly outbox = new Map<string, StoredMessage>();
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

  async transaction<T>(work: (tx: CopyTradeTransaction & ExecutionTransaction) => Promise<T>) {
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
  ): CopyTradeTransaction & ExecutionTransaction {
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
    };
  }

  create(record: FollowerRecord): Promise<FollowerRecord> {
    this.followers.set(record.id, record);
    return Promise.resolve(record);
  }

  findById(id: string): Promise<FollowerRecord | undefined> {
    return Promise.resolve(this.followers.get(id));
  }

  list(limit: number): Promise<readonly FollowerRecord[]> {
    return Promise.resolve([...this.followers.values()].slice(0, limit));
  }

  setCopyingEnabled(id: string, enabled: boolean, now: Date) {
    const current = this.followers.get(id);
    if (current === undefined) return Promise.resolve(undefined);
    const updated = { ...current, copyingEnabled: enabled, updatedAt: now };
    this.followers.set(id, updated);
    return Promise.resolve(updated);
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
