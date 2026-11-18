import { setTimeout as delay } from 'node:timers/promises';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseEnv,
  countBy,
  createFollower,
  postJson,
  spawnApi,
  startMigratedPostgres,
  type RunningApi,
} from './support';

let pg: StartedPostgreSqlContainer;
let apis: RunningApi[] = [];

beforeAll(async () => {
  pg = await startMigratedPostgres();
  const env = baseEnv(pg.getConnectionUri());
  apis = await Promise.all(
    ['api-1', 'api-2', 'api-3'].map((id) => spawnApi({ ...env, INSTANCE_ID: id })),
  );
});

afterAll(async () => {
  await Promise.all(apis.map((a) => a.stop()));
  await pg.stop();
});

const copy = (api: RunningApi, followerId: string, tradeId: string, amount: number) =>
  postJson(`${api.url}/v1/copy-trades`, {
    trade: { id: tradeId, traderId: 'trader', amount },
    followerId,
  });

const pick = (i: number): RunningApi => apis[i % apis.length]!;

async function servedRequests(api: RunningApi): Promise<number> {
  const text = await fetch(`${api.url}/metrics`).then((r) => r.text());
  return [...text.matchAll(/copy_trade_outcomes_total\{[^}]*\} (\d+)/g)].reduce(
    (sum, m) => sum + Number(m[1]),
    0,
  );
}

describe('3 API processes against one Postgres', () => {
  it('60 identical trades spread over all instances -> exactly one effect', async () => {
    const followerId = await createFollower(pick(0).url, 10_000, 2_000);

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => copy(pick(i), followerId, 'same-trade', 700)),
    );

    expect(countBy(responses.map((r) => r.status))).toEqual({ '200': 59, '201': 1 });
    const follower = (await fetch(`${pick(1).url}/v1/followers/${followerId}`).then((r) =>
      r.json(),
    )) as { balance: number; remainingAllocation: number };
    expect(follower).toMatchObject({ balance: 9_300, remainingAllocation: 1_300 });
  });

  it('30 different 700 trades on 1,000/1,000 across instances -> exactly one success', async () => {
    const followerId = await createFollower(pick(2).url, 1_000, 1_000);

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => copy(pick(i), followerId, `t-${String(i)}`, 700)),
    );

    expect(countBy(responses.map((r) => r.status))).toEqual({ '201': 1, '422': 29 });
    const follower = (await fetch(`${pick(0).url}/v1/followers/${followerId}`).then((r) =>
      r.json(),
    )) as { balance: number };
    expect(follower.balance).toBe(300);
  });

  it('every instance served traffic, relays settled each entry once, ledger reconciles', async () => {
    for (const api of apis) expect(await servedRequests(api)).toBeGreaterThan(0);

    let pending = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 50 && pending > 0; i++) {
      await delay(200);
      const report = (await fetch(`${pick(i).url}/v1/reconciliation`).then((r) => r.json())) as {
        consistent: boolean;
      };
      expect(report.consistent).toBe(true);
      const followers = (await fetch(`${pick(0).url}/v1/followers`).then((r) => r.json())) as {
        items: { id: string }[];
      };
      const trades = await Promise.all(
        followers.items.map(
          async (f) =>
            (
              (await fetch(`${pick(0).url}/v1/followers/${f.id}/trades`).then((r) => r.json())) as {
                items: { status: string }[];
              }
            ).items,
        ),
      );
      pending = trades.flat().filter((t) => t.status === 'pending').length;
    }
    expect(pending).toBe(0);
  });
});
