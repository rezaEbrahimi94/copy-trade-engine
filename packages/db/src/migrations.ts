import { sql, type Kysely } from 'kysely';
import type { Database } from './schema';
import { Migrator, type Migration, type MigrationResultSet } from 'kysely/migration';

/**
 * Migrations are code (not files discovered at runtime) so they survive bundling and are
 * type-checked. Never edit an applied migration; append a new one.
 */
export const migrations: Record<string, Migration> = {
  '2026_11_18_001_ledger_schema': {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable('followers')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('balance', 'bigint', (c) => c.notNull())
        .addColumn('remaining_allocation', 'bigint', (c) => c.notNull())
        .addColumn('opening_balance', 'bigint', (c) => c.notNull())
        .addColumn('opening_allocation', 'bigint', (c) => c.notNull())
        .addColumn('copying_enabled', 'boolean', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
        .addCheckConstraint('followers_balance_non_negative', sql`balance >= 0`)
        .addCheckConstraint('followers_allocation_non_negative', sql`remaining_allocation >= 0`)
        .addCheckConstraint(
          'followers_opening_non_negative',
          sql`opening_balance >= 0 AND opening_allocation >= 0`,
        )
        .execute();

      await db.schema
        .createTable('follower_trades')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('trade_id', 'text', (c) => c.notNull())
        .addColumn('trader_id', 'text', (c) => c.notNull())
        .addColumn('follower_id', 'text', (c) =>
          c.notNull().references('followers.id').onDelete('restrict'),
        )
        .addColumn('amount', 'bigint', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
        .addUniqueConstraint('follower_trades_trade_follower_key', ['trade_id', 'follower_id'])
        .addUniqueConstraint('follower_trades_idempotency_key', ['idempotency_key'])
        .addCheckConstraint('follower_trades_amount_positive', sql`amount > 0`)
        .addCheckConstraint(
          'follower_trades_status_valid',
          sql`status IN ('pending', 'executed', 'failed')`,
        )
        .execute();

      await db.schema
        .createIndex('follower_trades_follower_created_idx')
        .on('follower_trades')
        .columns(['follower_id', 'created_at'])
        .execute();

      await db.schema
        .createIndex('follower_trades_pending_idx')
        .on('follower_trades')
        .column('created_at')
        .where(sql.ref('status'), '=', 'pending')
        .execute();

      // Append-only ledger: rows are never deleted and only status may change, and only
      // pending -> executed | failed.
      await sql`
        CREATE FUNCTION follower_trades_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'follower_trades is append-only' USING ERRCODE = 'restrict_violation';
          END IF;
          IF NEW.id <> OLD.id OR NEW.trade_id <> OLD.trade_id OR NEW.trader_id <> OLD.trader_id
             OR NEW.follower_id <> OLD.follower_id OR NEW.amount <> OLD.amount
             OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
             OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'follower_trades ledger columns are immutable'
              USING ERRCODE = 'restrict_violation';
          END IF;
          IF NEW.status <> OLD.status AND OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'invalid status transition % -> %', OLD.status, NEW.status
              USING ERRCODE = 'restrict_violation';
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(db);
      await sql`
        CREATE TRIGGER follower_trades_append_only
        BEFORE UPDATE OR DELETE ON follower_trades
        FOR EACH ROW EXECUTE FUNCTION follower_trades_append_only()
      `.execute(db);

      await db.schema
        .createTable('outbox')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('follower_trade_id', 'text', (c) =>
          c.notNull().unique().references('follower_trades.id').onDelete('restrict'),
        )
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('available_at', 'timestamptz', (c) => c.notNull())
        .addColumn('processed_at', 'timestamptz')
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('outbox_due_idx')
        .on('outbox')
        .column('available_at')
        .where(sql.ref('processed_at'), 'is', null)
        .execute();
    },
  },

  '2026_11_18_002_event_driven': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('follower_trades').addColumn('handled_by', 'text').execute();
      // handled_by joins the immutable ledger columns.
      await sql`
        CREATE OR REPLACE FUNCTION follower_trades_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'follower_trades is append-only' USING ERRCODE = 'restrict_violation';
          END IF;
          IF NEW.id <> OLD.id OR NEW.trade_id <> OLD.trade_id OR NEW.trader_id <> OLD.trader_id
             OR NEW.follower_id <> OLD.follower_id OR NEW.amount <> OLD.amount
             OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
             OR NEW.handled_by IS DISTINCT FROM OLD.handled_by
             OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'follower_trades ledger columns are immutable'
              USING ERRCODE = 'restrict_violation';
          END IF;
          IF NEW.status <> OLD.status AND OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'invalid status transition % -> %', OLD.status, NEW.status
              USING ERRCODE = 'restrict_violation';
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(db);

      await db.schema
        .createTable('follower_subscriptions')
        .addColumn('follower_id', 'text', (c) =>
          c.notNull().references('followers.id').onDelete('cascade'),
        )
        .addColumn('trader_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addPrimaryKeyConstraint('follower_subscriptions_pk', ['follower_id', 'trader_id'])
        .execute();
      await db.schema
        .createIndex('follower_subscriptions_trader_idx')
        .on('follower_subscriptions')
        .column('trader_id')
        .execute();

      await db.schema
        .createTable('trades')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('trader_id', 'text', (c) => c.notNull())
        .addColumn('amount', 'bigint', (c) => c.notNull())
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .addCheckConstraint('trades_amount_positive', sql`amount > 0`)
        .execute();
      await db.schema.createIndex('trades_created_idx').on('trades').column('created_at').execute();

      // Transactional outbox for bus events. One row per publication; a forced redelivery adds
      // a row with the same event_id.
      await db.schema
        .createTable('event_outbox')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('event_id', 'text', (c) => c.notNull())
        .addColumn('topic', 'text', (c) => c.notNull())
        .addColumn('message_key', 'text', (c) => c.notNull())
        .addColumn('trade_id', 'text', (c) =>
          c.notNull().references('trades.id').onDelete('restrict'),
        )
        .addColumn('payload', 'jsonb', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('available_at', 'timestamptz', (c) => c.notNull())
        .addColumn('published_at', 'timestamptz')
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'timestamptz', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('event_outbox_due_idx')
        .on('event_outbox')
        .column('available_at')
        .where(sql.ref('published_at'), 'is', null)
        .execute();
      await db.schema
        .createIndex('event_outbox_trade_idx')
        .on('event_outbox')
        .columns(['trade_id', 'created_at'])
        .execute();

      // Inbox of the idempotent consumer: one row per consumed event id, written in the copy
      // transaction. No FK on follower_id: unknown followers are recorded as rejections.
      await db.schema
        .createTable('processed_events')
        .addColumn('event_id', 'text', (c) => c.primaryKey())
        .addColumn('trade_id', 'text', (c) => c.notNull())
        .addColumn('follower_id', 'text', (c) => c.notNull())
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('follower_trade_id', 'text', (c) =>
          c.references('follower_trades.id').onDelete('restrict'),
        )
        .addColumn('handled_by', 'text', (c) => c.notNull())
        .addColumn('topic', 'text')
        .addColumn('partition', 'integer')
        .addColumn('kafka_offset', 'text')
        .addColumn('processed_at', 'timestamptz', (c) => c.notNull())
        .addCheckConstraint(
          'processed_events_outcome_valid',
          sql`outcome IN ('copied', 'duplicate', 'rejected', 'idempotency_key_conflict')`,
        )
        .execute();
      await db.schema
        .createIndex('processed_events_trade_idx')
        .on('processed_events')
        .column('trade_id')
        .execute();

      await db.schema
        .createTable('instances')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('started_at', 'timestamptz', (c) => c.notNull())
        .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull())
        .addColumn('stopped_at', 'timestamptz')
        .addColumn('partitions', sql`integer[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
        .addCheckConstraint('instances_kind_valid', sql`kind IN ('api', 'worker')`)
        .execute();
    },
  },
};

export async function migrateToLatest(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error instanceof Error
      ? result.error
      : new Error('Migration failed', { cause: result.error });
  }
  return result;
}
