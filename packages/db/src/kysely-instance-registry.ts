import type { Kysely } from 'kysely';
import type { Database } from './schema';

export type InstanceKind = 'api' | 'worker';

export interface InstanceStatus {
  readonly id: string;
  readonly kind: InstanceKind;
  readonly startedAt: Date;
  readonly lastSeenAt: Date;
  readonly stoppedAt: Date | null;
  readonly alive: boolean;
  readonly partitions: readonly number[];
}

/**
 * Heartbeats of API replicas and workers, for the operations UI. Purely informational: no
 * correctness decision depends on it (Kafka group membership and row locks do that).
 */
export class KyselyInstanceRegistry {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async heartbeat(input: {
    id: string;
    kind: InstanceKind;
    startedAt: Date;
    now: Date;
    partitions?: readonly number[];
  }): Promise<void> {
    const partitions = [...(input.partitions ?? [])].sort((a, b) => a - b);
    await this.#db
      .insertInto('instances')
      .values({
        id: input.id,
        kind: input.kind,
        started_at: input.startedAt,
        last_seen_at: input.now,
        stopped_at: null,
        partitions,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          kind: input.kind,
          started_at: input.startedAt,
          last_seen_at: input.now,
          stopped_at: null,
          partitions,
        }),
      )
      .execute();
  }

  async markStopped(id: string, now: Date): Promise<void> {
    await this.#db
      .updateTable('instances')
      .set({ stopped_at: now, last_seen_at: now, partitions: [] })
      .where('id', '=', id)
      .execute();
  }

  /** Instances seen within `retentionMs`; `alive` = heartbeat within `aliveMs` and not stopped. */
  async list(now: Date, aliveMs: number, retentionMs: number): Promise<readonly InstanceStatus[]> {
    const rows = await this.#db
      .selectFrom('instances')
      .selectAll()
      .where('last_seen_at', '>=', new Date(now.getTime() - retentionMs))
      .orderBy('kind')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      startedAt: r.started_at,
      lastSeenAt: r.last_seen_at,
      stoppedAt: r.stopped_at,
      alive: r.stopped_at === null && now.getTime() - r.last_seen_at.getTime() <= aliveMs,
      partitions: r.partitions,
    }));
  }
}
