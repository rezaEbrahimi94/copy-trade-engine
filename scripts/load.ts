/**
 * Load test against the composed stack (through the nginx load balancer), then invariant and
 * reconciliation checks. Exits non-zero if any invariant fails.
 *
 *   pnpm load                       # defaults: http://127.0.0.1:3000, 6,000 + 600 requests
 *   LOAD_URL=... LOAD_REQUESTS=20000 LOAD_CONNECTIONS=128 pnpm load
 *   LOAD_KILL_WORKER=copy-trade-worker-2 pnpm load   # SIGKILL a worker while it drains phase 2
 *
 * Phase 1 (synchronous path): random POST /v1/copy-trades over a small pool of followers and
 *   trade ids, so most requests are duplicates or races on the same follower row.
 * Phase 2 (event bus): concurrent POST /v1/trades (with resubmissions) for a trader with many
 *   subscribers; the worker group consumes the fan-out. Then every event is republished
 *   (a redelivery storm) and the ledger must not change.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import autocannon from 'autocannon';
import {
  FollowerSchema,
  FollowerTradeListSchema,
  INSTANCE_ID_HEADER,
  InstanceListSchema,
  ReconciliationReportSchema,
  TradeViewSchema,
  type FollowerDto,
} from '@copy-trade/contracts';
import type { z } from 'zod';

const URL_BASE = process.env['LOAD_URL'] ?? 'http://127.0.0.1:3000';
const REQUESTS = Number(process.env['LOAD_REQUESTS'] ?? 6_000);
const CONNECTIONS = Number(process.env['LOAD_CONNECTIONS'] ?? 64);
const FOLLOWERS = Number(process.env['LOAD_FOLLOWERS'] ?? 40);
const TRADES = Number(process.env['LOAD_TRADES'] ?? 60);
const BUS_FOLLOWERS = Number(process.env['LOAD_BUS_FOLLOWERS'] ?? 48);
const BUS_TRADES = Number(process.env['LOAD_BUS_TRADES'] ?? 12);
const KILL_WORKER = process.env['LOAD_KILL_WORKER'];
const AMOUNT = 700;
const run = randomUUID().slice(0, 8);

const failures: string[] = [];
function check(ok: boolean, label: string): void {
  process.stdout.write(`  ${ok ? '✔' : '✘'} ${label}\n`);
  if (!ok) failures.push(label);
}

async function call<S extends z.ZodType>(
  schema: S,
  path: string,
  init?: RequestInit,
): Promise<z.infer<S>> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  const res = await fetch(`${URL_BASE}${path}`, { ...init, headers });
  const json: unknown = await res.json();
  if (!res.ok) throw new Error(`${path} -> HTTP ${String(res.status)}: ${JSON.stringify(json)}`);
  return schema.parse(json);
}

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T;
const capOf = (f: FollowerDto) =>
  Math.floor(Math.min(f.openingBalance, f.openingAllocation) / AMOUNT);
const OPENINGS: readonly [number, number][] = [
  [1_000, 1_000],
  [2_000, 1_500],
  [3_500, 10_000],
  [10_000, 2_000],
  [50_000, 50_000],
];

interface Hammered {
  readonly result: autocannon.Result;
  readonly statuses: Map<number, number>;
  readonly instances: Map<string, number>;
}

async function hammer(
  title: string,
  path: string,
  amount: number,
  body: () => unknown,
): Promise<Hammered> {
  const statuses = new Map<number, number>();
  const instances = new Map<string, number>();
  const result = await autocannon({
    url: URL_BASE,
    title,
    connections: CONNECTIONS,
    amount,
    requests: [
      {
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json' },
        setupRequest: (req) => ({ ...req, body: JSON.stringify(body()) }),
        onResponse: ((
          status: number,
          _body: string,
          _ctx: unknown,
          headers: Record<string, string>,
        ) => {
          statuses.set(status, (statuses.get(status) ?? 0) + 1);
          const instance = headers[INSTANCE_ID_HEADER] ?? '?';
          instances.set(instance, (instances.get(instance) ?? 0) + 1);
        }) as autocannon.Request['onResponse'],
      },
    ],
  });
  const fmt = (m: Map<string | number, number>) =>
    [...m.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([k, v]) => `${String(k)}=${String(v)}`)
      .join(' ');
  process.stdout.write(
    `\n${title}: ${String(result.requests.total)} requests in ${String(result.duration)}s, ` +
      `${String(Math.round(result.requests.average))} req/s, latency p50=${String(result.latency.p50)}ms ` +
      `p99=${String(result.latency.p99)}ms, errors=${String(result.errors)} timeouts=${String(result.timeouts)}\n` +
      `  status: ${fmt(statuses)}\n  served by: ${fmt(instances)}\n`,
  );
  return { result, statuses, instances };
}

const createFollowers = (count: number, traderIds: string[]) =>
  Promise.all(
    Array.from({ length: count }, (_, i) => {
      const [balance, allocation] = OPENINGS[i % OPENINGS.length] ?? [1_000, 1_000];
      return call(FollowerSchema, '/v1/followers', {
        method: 'POST',
        body: JSON.stringify({ balance, allocation, copyingEnabled: true, traderIds }),
      });
    }),
  );

async function verifyFollowers(
  followers: readonly FollowerDto[],
  attempted: Map<string, Set<string>>,
): Promise<string[]> {
  const handledBy: string[] = [];
  let ok = 0;
  for (const opening of followers) {
    const [now, trades] = await Promise.all([
      call(FollowerSchema, `/v1/followers/${opening.id}`),
      call(FollowerTradeListSchema, `/v1/followers/${opening.id}/trades`),
    ]);
    const copies = trades.items.length;
    const distinct = new Set(trades.items.map((t) => t.tradeId)).size;
    const expected = Math.min(capOf(opening), attempted.get(opening.id)?.size ?? 0);
    handledBy.push(...trades.items.map((t) => t.handledBy ?? '?'));
    const good =
      now.balance >= 0 &&
      now.remainingAllocation >= 0 &&
      distinct === copies &&
      copies === expected &&
      now.balance === opening.openingBalance - AMOUNT * copies &&
      now.remainingAllocation === opening.openingAllocation - AMOUNT * copies;
    if (good) ok += 1;
    else
      process.stdout.write(
        `    follower ${opening.id}: copies=${String(copies)} distinct=${String(distinct)} expected=${String(expected)} balance=${String(now.balance)} allocation=${String(now.remainingAllocation)}\n`,
      );
  }
  check(
    ok === followers.length,
    `${String(ok)}/${String(followers.length)} followers: never negative, one ledger row per (trade, follower), copies = min(attempted trades, floor(min(balance, allocation) / 700)), balance and allocation = opening − 700 × copies`,
  );
  return handledBy;
}

async function phaseSynchronous(apiReplicas: number) {
  process.stdout.write(`\n== Phase 1: POST /v1/copy-trades through the load balancer ==\n`);
  const followers = await createFollowers(FOLLOWERS, []);
  const tradeIds = Array.from({ length: TRADES }, (_, i) => `load-${run}-${String(i)}`);
  const attempted = new Map<string, Set<string>>();
  const { result, statuses, instances } = await hammer(
    'copy-trades',
    '/v1/copy-trades',
    REQUESTS,
    () => {
      const follower = pick(followers);
      const tradeId = pick(tradeIds);
      const set = attempted.get(follower.id) ?? new Set<string>();
      set.add(tradeId);
      attempted.set(follower.id, set);
      return {
        trade: { id: tradeId, traderId: `trader-${run}`, amount: AMOUNT },
        followerId: follower.id,
      };
    },
  );

  const unexpected = [...statuses.keys()].filter((s) => ![200, 201, 422].includes(s));
  check(
    result.errors === 0 && result.timeouts === 0 && unexpected.length === 0,
    'only 201 / 200 / 422, no errors or timeouts',
  );
  check(instances.size === apiReplicas, `all ${String(apiReplicas)} API replicas served requests`);
  const handledBy = await verifyFollowers(followers, attempted);
  check(
    new Set(handledBy).size === apiReplicas,
    `ledger rows written by all ${String(apiReplicas)} API replicas`,
  );
}

async function phaseEventBus(workers: number) {
  process.stdout.write(`\n== Phase 2: POST /v1/trades → outbox → Redpanda → worker group ==\n`);
  const traderId = `bus-trader-${run}`;
  const followers = await createFollowers(BUS_FOLLOWERS, [traderId]);
  const tradeIds = Array.from({ length: BUS_TRADES }, (_, i) => `bus-${run}-${String(i)}`);
  const { result, statuses } = await hammer('open trades', '/v1/trades', BUS_TRADES * 50, () => ({
    id: pick(tradeIds),
    traderId,
    amount: AMOUNT,
  }));
  check(
    result.errors === 0 && statuses.get(202) === BUS_TRADES,
    `each of ${String(BUS_TRADES)} trades accepted exactly once (202), all resubmissions 200 duplicate`,
  );

  const started = Date.now();
  if (KILL_WORKER !== undefined) {
    execFileSync('docker', ['kill', KILL_WORKER]);
    process.stdout.write(
      `  SIGKILLed ${KILL_WORKER} mid-drain; the group rebalances after the session timeout\n`,
    );
  }
  const views = await waitForViews(tradeIds);
  process.stdout.write(
    `  workers drained ${String(BUS_TRADES * BUS_FOLLOWERS)} events in ${String(Date.now() - started)}ms after the burst\n`,
  );
  const requests = views.flatMap((v) => v.requests);
  check(
    requests.length === BUS_TRADES * BUS_FOLLOWERS,
    `${String(requests.length)} TradeOpened events = trades × subscribers`,
  );
  check(
    new Set(requests.map((r) => r.eventId)).size === requests.length,
    'one processed record per event id (inbox)',
  );
  const used = new Set(requests.map((r) => r.processed?.handledBy));
  const expectedWorkers = KILL_WORKER === undefined ? workers : workers - 1;
  check(
    used.size >= expectedWorkers,
    `${String(used.size)} of ${String(workers)} workers processed events (${[...used].sort().join(', ')})`,
  );

  const attempted = new Map(followers.map((f) => [f.id, new Set(tradeIds)]));
  await verifyFollowers(followers, attempted);

  process.stdout.write('  redelivery storm: republishing every event of every trade\n');
  const before = requests
    .map((r) => `${r.eventId}:${r.processed?.outcome ?? ''}:${r.processed?.followerTradeId ?? ''}`)
    .sort();
  for (const id of tradeIds)
    await fetch(`${URL_BASE}/v1/trades/${id}/republish`, { method: 'POST' });
  await delay(4_000);
  const after = (await waitForViews(tradeIds))
    .flatMap((v) => v.requests)
    .map((r) => `${r.eventId}:${r.processed?.outcome ?? ''}:${r.processed?.followerTradeId ?? ''}`)
    .sort();
  check(
    JSON.stringify(before) === JSON.stringify(after),
    'redelivered events changed nothing (outcomes and ledger ids identical)',
  );
  await verifyFollowers(followers, attempted);
}

async function waitForViews(tradeIds: readonly string[]) {
  for (let i = 0; ; i++) {
    const views = await Promise.all(
      tradeIds.map((id) => call(TradeViewSchema, `/v1/trades/${id}`)),
    );
    if (views.every((v) => v.requests.every((r) => r.processed !== null))) return views;
    if (i > 600) throw new Error('workers did not drain within 60s');
    await delay(100);
  }
}

const instances = await call(InstanceListSchema, '/v1/instances');
const apiReplicas = instances.items.filter((i) => i.kind === 'api' && i.alive).length;
const workers = instances.items.filter((i) => i.kind === 'worker' && i.alive).length;
process.stdout.write(
  `Target ${URL_BASE}: ${String(apiReplicas)} API replicas, ${String(workers)} workers alive\n`,
);

await phaseSynchronous(apiReplicas);
if (workers > 0) await phaseEventBus(workers);

process.stdout.write('\n== Reconciliation ==\n');
const report = await call(ReconciliationReportSchema, '/v1/reconciliation');
check(
  report.consistent && report.summary.driftedFollowers === 0,
  `consistent: ${String(report.summary.followersChecked)} followers checked, ${String(report.summary.driftedFollowers)} drifted, ${String(report.stuckPending)} stuck pending`,
);

process.stdout.write(
  failures.length === 0
    ? '\nALL INVARIANTS HOLD\n'
    : `\n${String(failures.length)} INVARIANT(S) FAILED\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
