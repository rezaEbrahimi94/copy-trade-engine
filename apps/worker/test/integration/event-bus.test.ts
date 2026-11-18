import { randomUUID } from 'node:crypto';
import { EventRelayService, TradeService } from '@copy-trade/application';
import { EVENT_HEADERS, TOPICS } from '@copy-trade/contracts';
import { KafkaEventPublisher, headerString } from '@copy-trade/messaging';
import { KyselyTradeReadRepository, KyselyUnitOfWork, type Database } from '@copy-trade/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ids,
  insertFollower,
  services,
  startPostgres,
  subscribe,
  systemClock,
  type TestDatabase,
} from '../../../../packages/db/test/support/postgres';
import {
  PARTITIONS,
  produce,
  readTopic,
  spawnWorker,
  startBus,
  startWorker,
  tradeOpened,
  waitFor,
  waitForAssignment,
  type Bus,
  type InProcessWorker,
} from './support';

let pg: TestDatabase;
let bus: Bus;
let db: Kysely<Database>;

beforeAll(async () => {
  [pg, bus] = await Promise.all([startPostgres(), startBus()]);
  db = pg.connect(60, 'event-bus-test');
});

afterAll(async () => {
  await bus.stop();
  await pg.stop();
});

beforeEach(async () => {
  await pg.reset();
});

const processedRows = (eventIds?: readonly string[]) => {
  let query = db.selectFrom('processed_events').selectAll();
  if (eventIds !== undefined) query = query.where('event_id', 'in', eventIds);
  return query.execute();
};

const waitForProcessed = (count: number, timeoutMs = 60_000) =>
  waitFor(
    `${String(count)} processed events`,
    async () => {
      const rows = await processedRows();
      return rows.length >= count ? rows : undefined;
    },
    timeoutMs,
  );

const ledgerByKey = async () =>
  db.selectFrom('follower_trades').select(['follower_id', 'trade_id', 'handled_by']).execute();

async function expectCleanReconciliation() {
  const report = await services(db).reconciliation.run();
  expect(report.drifted).toEqual([]);
  expect(report.stuckPending).toBe(0);
  const negative = await db
    .selectFrom('followers')
    .select('id')
    .where((eb) => eb.or([eb('balance', '<', 0), eb('remaining_allocation', '<', 0)]))
    .execute();
  expect(negative).toEqual([]);
}

async function startGroup(count: number, topic: string): Promise<InProcessWorker[]> {
  const groupId = `group-${randomUUID()}`;
  const workers: InProcessWorker[] = [];
  for (let i = 1; i <= count; i++) {
    workers.push(
      await startWorker(bus, {
        id: `worker-${String(i)}`,
        topic,
        groupId,
        copyTrades: services(db, { followerLocking: 'for-update' }).copyTrades,
      }),
    );
  }
  await waitForAssignment(workers);
  return workers;
}

const stopAll = (workers: readonly InProcessWorker[]) => Promise.all(workers.map((w) => w.stop()));

async function resultEventsFor(eventIds: readonly string[], minimum: number) {
  const wanted = new Set(eventIds);
  const matches = (m: { headers?: Record<string, unknown> }) =>
    wanted.has(headerString(m.headers?.[EVENT_HEADERS.causationId] as Buffer | undefined) ?? '');
  const completed = await readTopic(
    bus,
    TOPICS.completed,
    (ms) => ms.filter(matches).length >= minimum,
  );
  return completed.filter(matches);
}

describe('event-driven copy trading over Redpanda (Testcontainers)', () => {
  it('API outbox → relay → copy-trade.requested → 3 workers → Postgres, results on copy-trade.completed', async () => {
    const topic = await bus.newTopic();
    const followers = Array.from({ length: 30 }, (_, i) => `ff-${String(i).padStart(2, '0')}`);
    for (const id of followers) {
      await insertFollower(db, id, 1_000, 1_000);
      await subscribe(db, id, ['trader-x']);
    }
    await insertFollower(db, 'not-subscribed', 1_000, 1_000);

    const unitOfWork = new KyselyUnitOfWork(db);
    const trades = new TradeService({
      unitOfWork,
      reads: new KyselyTradeReadRepository(db),
      clock: systemClock,
      ids,
      retry: {
        maxAttempts: 5,
        baseDelayMs: 5,
        sleep: () => Promise.resolve(),
        random: Math.random,
      },
      requestedTopic: topic,
      listLimit: 50,
    });
    const producerRelay = new EventRelayService({
      unitOfWork,
      publisher: new KafkaEventPublisher(bus.producer, 'api-test'),
      clock: systemClock,
      batchSize: 100,
      retryDelayMs: 100,
    });
    const workers = await startGroup(3, topic);

    const opened = await trades.openTrade({ id: 'T-1', traderId: 'trader-x', amount: 700 });
    expect(opened).toMatchObject({ outcome: 'accepted' });
    expect(await trades.openTrade({ id: 'T-1', traderId: 'trader-x', amount: 700 })).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await producerRelay.drain(10)).toBe(30);

    const rows = await waitForProcessed(30);
    expect(rows.every((r) => r.outcome === 'copied')).toBe(true);
    expect(new Set(rows.map((r) => r.partition)).size).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.handled_by)).size).toBe(3);
    const ledger = await ledgerByKey();
    expect(ledger).toHaveLength(30);
    expect(ledger.every((r) => r.handled_by?.startsWith('worker-'))).toBe(true);
    expect(
      await db.selectFrom('follower_trades').where('follower_id', '=', 'not-subscribed').execute(),
    ).toEqual([]);

    const view = await trades.get('T-1');
    expect(view?.requests.map((r) => r.processed?.outcome)).toEqual(Array(30).fill('copied'));

    const completed = await resultEventsFor(
      rows.map((r) => r.event_id),
      30,
    );
    const payloads = completed.map(
      (m) => JSON.parse(m.value?.toString() ?? '{}') as { type: string; handledBy: string },
    );
    expect(new Set(payloads.map((p) => p.type))).toEqual(new Set(['CopyTradeCompleted']));
    await expectCleanReconciliation();
    await stopAll(workers);
  });

  it('redelivery of the same message (same eventId, twice on the wire and via republish) has one effect', async () => {
    const topic = await bus.newTopic();
    await insertFollower(db, 'f1', 1_000, 1_000);
    const workers = await startGroup(2, topic);
    const event = tradeOpened('evt-same', 'T-redeliver', 'f1');

    await produce(bus, topic, [event, event, event]);
    await waitFor('3 outcomes', () =>
      workers.flatMap((w) => w.outcomes).length >= 3 ? true : undefined,
    );

    const outcomes = workers.flatMap((w) => w.outcomes);
    expect(outcomes.map((o) => (o.kind === 'processed' ? o.redelivered : 'dlq'))).toEqual([
      false,
      true,
      true,
    ]);
    expect(await processedRows()).toHaveLength(1);
    expect(await ledgerByKey()).toHaveLength(1);
    expect(
      await db
        .selectFrom('followers')
        .select(['balance', 'remaining_allocation'])
        .executeTakeFirst(),
    ).toEqual({
      balance: 300,
      remaining_allocation: 300,
    });
    await expectCleanReconciliation();
    await stopAll(workers);
  });

  it('duplicate trade events (different eventIds, same trade and follower) copy once', async () => {
    const topic = await bus.newTopic();
    await insertFollower(db, 'f1', 5_000, 5_000);
    const workers = await startGroup(3, topic);

    await produce(bus, topic, [
      tradeOpened('evt-a', 'T-dup', 'f1'),
      tradeOpened('evt-b', 'T-dup', 'f1'),
      tradeOpened('evt-c', 'T-dup', 'f1'),
    ]);
    const rows = await waitForProcessed(3);

    expect(rows.map((r) => r.outcome).sort()).toEqual(['copied', 'duplicate', 'duplicate']);
    const copiedId = rows.find((r) => r.outcome === 'copied')?.follower_trade_id;
    expect(rows.every((r) => r.follower_trade_id === copiedId)).toBe(true);
    expect(await ledgerByKey()).toHaveLength(1);
    await expectCleanReconciliation();
    await stopAll(workers);
  });

  it('concurrent 700/700 for the same follower handled by different workers: exactly one copy', async () => {
    const topic = await bus.newTopic();
    const workers = await startGroup(3, topic);
    const [first, second] = workers;
    const partitionA = first?.consumer.assignedPartitions[0];
    const partitionB = second?.consumer.assignedPartitions[0];
    if (partitionA === undefined || partitionB === undefined) throw new Error('no assignment');

    const followers = Array.from({ length: 40 }, (_, i) => `race-${String(i)}`);
    for (const id of followers) await insertFollower(db, id, 1_000, 1_000);

    // Same follower, two different trades, deliberately on partitions owned by different
    // workers, so the row lock in Postgres is the only thing serialising them.
    await Promise.all([
      produce(
        bus,
        topic,
        followers.map((f) => tradeOpened(`a-${f}`, `TA-${f}`, f)),
        partitionA,
      ),
      produce(
        bus,
        topic,
        followers.map((f) => tradeOpened(`b-${f}`, `TB-${f}`, f)),
        partitionB,
      ),
    ]);
    const rows = await waitForProcessed(80);

    for (const follower of followers) {
      const mine = rows.filter((r) => r.follower_id === follower);
      expect(mine.map((r) => r.outcome).sort()).toEqual(['copied', 'rejected']);
      expect(mine.find((r) => r.outcome === 'rejected')?.reason).toBe('INSUFFICIENT_BALANCE');
      expect(new Set(mine.map((r) => r.handled_by)).size).toBe(2);
    }
    const balances = await db
      .selectFrom('followers')
      .select(['balance', 'remaining_allocation'])
      .execute();
    expect(balances.every((b) => b.balance === 300 && b.remaining_allocation === 300)).toBe(true);
    expect(await ledgerByKey()).toHaveLength(40);
    await expectCleanReconciliation();
    await stopAll(workers);
  });

  it('NEGATIVE CONTROL: with the follower row lock removed, the cross-worker race is detected', async () => {
    let doubleCopied = 0;
    let drifted = 0;
    let round = 0;
    for (; round < 5 && drifted === 0; round++) {
      await pg.reset();
      const topic = await bus.newTopic();
      const groupId = `unsafe-${randomUUID()}`;
      const workers: InProcessWorker[] = [];
      for (const id of ['worker-1', 'worker-2']) {
        workers.push(
          await startWorker(bus, {
            id,
            topic,
            groupId,
            copyTrades: services(db, { followerLocking: 'none' }).copyTrades,
          }),
        );
      }
      await waitForAssignment(workers);
      const partitionA = workers[0]?.consumer.assignedPartitions[0] ?? 0;
      const partitionB = workers[1]?.consumer.assignedPartitions[0] ?? 1;
      const followers = Array.from({ length: 60 }, (_, i) => `nc-${String(i)}`);
      for (const id of followers) await insertFollower(db, id, 1_000, 1_000);
      await Promise.all([
        produce(
          bus,
          topic,
          followers.map((f) => tradeOpened(`a-${f}`, `TA-${f}`, f)),
          partitionA,
        ),
        produce(
          bus,
          topic,
          followers.map((f) => tradeOpened(`b-${f}`, `TB-${f}`, f)),
          partitionB,
        ),
      ]);
      const rows = await waitForProcessed(120);
      await stopAll(workers);
      doubleCopied = followers.filter(
        (f) => rows.filter((r) => r.follower_id === f && r.outcome === 'copied').length > 1,
      ).length;
      drifted = (await services(db).reconciliation.run()).summary.driftedFollowers;
    }
    process.stdout.write(
      `[event-bus negative-control] rounds=${String(round)} doubleCopied=${String(doubleCopied)} drifted=${String(drifted)}\n`,
    );
    expect(doubleCopied).toBeGreaterThan(0);
    expect(drifted).toBeGreaterThan(0);
  });

  it('graceful stop rebalances partitions to the survivors', async () => {
    const topic = await bus.newTopic();
    const workers = await startGroup(3, topic);
    const [leaving, ...staying] = workers;
    await leaving?.stop();

    await waitFor('rebalance onto 2 workers', () => {
      const owned = staying.flatMap((w) => w.consumer.assignedPartitions);
      return owned.length === PARTITIONS &&
        staying.every((w) => w.consumer.assignedPartitions.length > 0)
        ? true
        : undefined;
    });
    await insertFollower(db, 'after', 1_000, 1_000);
    await produce(bus, topic, [tradeOpened('evt-after', 'T-after', 'after')]);
    const [row] = await waitForProcessed(1);
    expect(staying.map((w) => w.id)).toContain(row?.handled_by);
    await stopAll(staying);
  });

  it('DLQ: malformed messages and exhausted retries are dead-lettered and do not block the partition', async () => {
    const topic = await bus.newTopic();
    await insertFollower(db, 'f1', 1_000, 1_000);
    const marker = randomUUID();
    let failures = 0;
    const real = services(db).copyTrades;
    const worker = await startWorker(bus, {
      id: 'worker-dlq',
      topic,
      groupId: `group-${marker}`,
      maxAttempts: 3,
      copyTrades: {
        processRequestedEvent: (command) => {
          if (command.trade.id === 'T-poison') {
            failures += 1;
            return Promise.reject(new Error('simulated persistent failure'));
          }
          return real.processRequestedEvent(command);
        },
      },
    });
    await waitForAssignment([worker]);

    await bus.producer.send({
      topic,
      messages: [{ key: 'f1', value: `not json ${marker}`, partition: 0 }],
    });
    await produce(bus, topic, [tradeOpened(`poison-${marker}`, 'T-poison', 'f1')], 0);
    await produce(bus, topic, [tradeOpened(`good-${marker}`, 'T-good', 'f1')], 0);

    const [row] = await waitForProcessed(1);
    expect(row).toMatchObject({ event_id: `good-${marker}`, outcome: 'copied', partition: 0 });
    expect(failures).toBe(3);
    expect(worker.outcomes.map((o) => o.kind)).toEqual([
      'dead_lettered',
      'dead_lettered',
      'processed',
    ]);

    const mine = (ms: readonly { value: Buffer | null; headers?: Record<string, unknown> }[]) =>
      ms.filter(
        (m) =>
          m.value?.toString().includes(marker) === true &&
          headerString(m.headers?.[EVENT_HEADERS.dlqSource] as Buffer | undefined)?.startsWith(
            topic,
          ) === true,
      );
    const dead = mine(await readTopic(bus, TOPICS.deadLetter, (ms) => mine(ms).length >= 2));
    const header = (i: number, name: string) =>
      headerString(dead[i]?.headers?.[name] as Buffer | undefined);
    expect([header(0, EVENT_HEADERS.dlqReason), header(1, EVENT_HEADERS.dlqReason)]).toEqual([
      'invalid_payload',
      'processing_failed',
    ]);
    expect(header(1, EVENT_HEADERS.dlqAttempts)).toBe('3');
    expect(header(1, EVENT_HEADERS.dlqError)).toBe('simulated persistent failure');
    expect(header(1, EVENT_HEADERS.dlqSource)).toBe(`${topic}/0@1`);
    expect(await ledgerByKey()).toHaveLength(1);
    await worker.stop();
  });

  it('SIGKILL of a worker process mid-run: rebalance, redelivery, no double effect; restart rejoins', async () => {
    const topic = await bus.newTopic();
    const groupId = `group-${randomUUID()}`;
    const env = {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: pg.url,
      DB_POOL_MAX: '10',
      KAFKA_BROKERS: bus.brokers,
      KAFKA_REQUESTED_TOPIC: topic,
      CONSUMER_GROUP: groupId,
      KAFKA_SESSION_TIMEOUT_MS: '6000',
      KAFKA_HEARTBEAT_INTERVAL_MS: '500',
      WORKER_CONCURRENCY: '6',
      WORKER_SIMULATED_LATENCY_MS: '25',
      HEARTBEAT_INTERVAL_MS: '500',
      LAG_INTERVAL_MS: '500',
    };
    const followers = Array.from({ length: 100 }, (_, i) => `k-${String(i).padStart(3, '0')}`);
    for (const id of followers) await insertFollower(db, id, 1_000, 1_000);

    const procs = [
      await spawnWorker(env, 'worker-1'),
      await spawnWorker(env, 'worker-2'),
      await spawnWorker(env, 'worker-3'),
    ];
    // Per follower: trade A, trade B (700 + 700 on 1,000), and a resend of A's event.
    const events = followers.flatMap((f) => [
      tradeOpened(`a-${f}`, `TA-${f}`, f),
      tradeOpened(`b-${f}`, `TB-${f}`, f),
      tradeOpened(`a-${f}`, `TA-${f}`, f),
    ]);
    await produce(bus, topic, events);

    await waitForProcessed(40);
    const victimPartitions = await waitFor('worker-2 heartbeat with partitions', async () => {
      const row = await db
        .selectFrom('instances')
        .select('partitions')
        .where('id', '=', 'worker-2')
        .executeTakeFirst();
      return row !== undefined && row.partitions.length > 0 ? row.partitions : undefined;
    });
    const [, victim] = procs;
    await victim?.kill();
    const killedAt = new Date();

    const rows = await waitForProcessed(200, 120_000);
    expect(rows).toHaveLength(200);
    for (const follower of followers) {
      const mine = rows.filter((r) => r.follower_id === follower);
      expect(mine.map((r) => r.outcome).sort()).toEqual(['copied', 'rejected']);
    }
    expect(await ledgerByKey()).toHaveLength(100);
    const handledBy = new Set(rows.map((r) => r.handled_by));
    expect(handledBy).toContain('worker-1');
    expect(handledBy).toContain('worker-3');
    const takenOver = rows.filter(
      (r) =>
        r.partition !== null && victimPartitions.includes(r.partition) && r.processed_at > killedAt,
    );
    expect(takenOver.length).toBeGreaterThan(0);
    expect(takenOver.every((r) => r.handled_by !== 'worker-2')).toBe(true);
    await expectCleanReconciliation();

    const restarted = await spawnWorker(env, 'worker-2');
    const metrics = await waitFor('worker-2 assigned partitions', async () => {
      const text = await fetch(`${restarted.metricsUrl}/metrics`).then((r) => r.text());
      return /kafka_assigned_partitions\S* [1-9]/.test(text) ? text : undefined;
    });
    expect(metrics).toContain('worker_messages_processed_total');

    const [first, , third] = procs;
    if (first === undefined || third === undefined) throw new Error('missing worker process');
    const exitCodes = await Promise.all([first, third, restarted].map((p) => p.terminate()));
    expect(exitCodes).toEqual([0, 0, 0]);
    expect(await ledgerByKey()).toHaveLength(100);
  });
});
