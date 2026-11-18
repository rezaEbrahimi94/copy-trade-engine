import { spawnSync } from 'node:child_process';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { createContainer, type Container } from '../../src/container';
import { buildApp, type App } from '../../src/http/app';
import {
  API_DIR,
  baseEnv,
  countBy,
  createFollower,
  postJson,
  startMigratedPostgres,
} from './support';

let pgContainer: StartedPostgreSqlContainer;
let container: Container;
let app: App;
let url: string;

beforeAll(async () => {
  pgContainer = await startMigratedPostgres();
  const config = loadConfig({
    ...baseEnv(pgContainer.getConnectionUri()),
    PORT: '0',
    DB_POOL_MAX: '60',
  });
  container = createContainer(config, pino({ level: 'silent' }));
  app = await buildApp(container);
  url = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await container.dispose();
  await pgContainer.stop();
});

const copy = (followerId: string, tradeId: string, amount: number) =>
  postJson(`${url}/v1/copy-trades`, {
    trade: { id: tradeId, traderId: 'trader', amount },
    followerId,
  });

describe('HTTP over real sockets + Postgres', () => {
  it('scenario 1 via HTTP', async () => {
    const followerId = await createFollower(url, 10_000, 2_000);
    const res = await copy(followerId, 's1', 700);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ follower: { balance: 9_300, remainingAllocation: 1_300 } });
  });

  it('50 concurrent identical HTTP requests -> one 201, forty-nine 200 duplicates, one row', async () => {
    const followerId = await createFollower(url, 10_000, 2_000);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => copy(followerId, 'same', 700)),
    );

    expect(countBy(responses.map((r) => r.status))).toEqual({ '200': 49, '201': 1 });
    const ids = new Set(responses.map((r) => (r.body['followerTrade'] as { id: string }).id));
    expect(ids.size).toBe(1);
    const trades = await fetch(`${url}/v1/followers/${followerId}/trades`).then((r) => r.json());
    expect((trades as { items: unknown[] }).items).toHaveLength(1);
  });

  it('20 concurrent different 700 trades on 1,000/1,000 -> one 201, nineteen 422', async () => {
    const followerId = await createFollower(url, 1_000, 1_000);
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => copy(followerId, `c${String(i)}`, 700)),
    );
    expect(countBy(responses.map((r) => r.status))).toEqual({ '201': 1, '422': 19 });
    const follower = (await fetch(`${url}/v1/followers/${followerId}`).then((r) => r.json())) as {
      balance: number;
    };
    expect(follower.balance).toBe(300);
  });

  it('readiness reports the database check', async () => {
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('reconciliation job: exit 0 when consistent, exit 1 with drift (never auto-fixes)', () => {
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/reconcile.ts'], {
        cwd: API_DIR,
        env: baseEnv(pgContainer.getConnectionUri()),
        encoding: 'utf8',
      });

    const clean = run();
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ consistent: true });

    return (async () => {
      const followerId = await createFollower(url, 1_000, 1_000);
      await container.db
        .updateTable('followers')
        .set({ balance: 1 })
        .where('id', '=', followerId)
        .execute();
      const drifted = run();
      expect(drifted.status).toBe(1);
      expect(JSON.parse(drifted.stdout)).toMatchObject({
        consistent: false,
        drifted: [{ followerId, balanceDrift: -999 }],
      });
      expect(drifted.stdout + drifted.stderr).toContain('ledger drift detected');
      const after = await container.db
        .selectFrom('followers')
        .select('balance')
        .where('id', '=', followerId)
        .executeTakeFirstOrThrow();
      expect(after.balance).toBe(1);
    })();
  });
});
