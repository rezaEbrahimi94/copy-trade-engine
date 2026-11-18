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
