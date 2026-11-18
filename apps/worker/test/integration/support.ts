import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CopyTradeService, TradeOpenedEvent } from '@copy-trade/application';
import { TOPICS } from '@copy-trade/contracts';
import {
  createKafka,
  createProducer,
  encodeTradeOpened,
  ensureTopics,
  KafkaWorkerOutput,
} from '@copy-trade/messaging';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import type { Kafka, KafkaMessage, Producer } from 'kafkajs';
import { pino, type Logger } from 'pino';
import { CopyTradeConsumer } from '../../src/consumer';
import { createMessageHandler, type HandleOutcome } from '../../src/handler';
import { createWorkerMetrics } from '../../src/metrics';

export const WORKER_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const REDPANDA_IMAGE = 'docker.redpanda.com/redpandadata/redpanda:v25.2.10';
export const PARTITIONS = 6;

export const logger: Logger = pino({ level: process.env['TEST_LOG_LEVEL'] ?? 'silent' });

export interface Bus {
  readonly container: StartedRedpandaContainer;
  readonly brokers: string;
  readonly kafka: Kafka;
  readonly producer: Producer;
  /** A fresh requested topic per test keeps tests independent on one broker. */
  newTopic(): Promise<string>;
  stop(): Promise<void>;
}

export async function startBus(): Promise<Bus> {
  const container = await new RedpandaContainer(REDPANDA_IMAGE).start();
  const brokers = container.getBootstrapServers();
  const kafka = createKafka({ brokers: [brokers], clientId: 'test', logger });
  const admin = kafka.admin();
  await admin.connect();
  await ensureTopics(admin, { requestedPartitions: PARTITIONS, resultPartitions: 3 }, TOPICS);
  const producer = createProducer(kafka);
  await producer.connect();
  return {
    container,
    brokers,
    kafka,
    producer,
    async newTopic() {
      const topic = `copy-trade.requested.${randomUUID().slice(0, 8)}`;
      await ensureTopics(
        admin,
        { requestedPartitions: PARTITIONS, resultPartitions: 3 },
        { ...TOPICS, requested: topic },
      );
      return topic;
    },
    async stop() {
      await producer.disconnect();
      await admin.disconnect();
      await container.stop();
    },
  };
}

export const tradeOpened = (
  eventId: string,
  tradeId: string,
  followerId: string,
  amount = 700,
): TradeOpenedEvent => ({
  eventId,
  type: 'TradeOpened',
  version: 1,
  occurredAt: new Date().toISOString(),
  trade: { id: tradeId, traderId: 'trader', amount },
  followerId,
});

export async function produce(
  bus: Bus,
  topic: string,
  events: readonly TradeOpenedEvent[],
  partition?: number,
): Promise<void> {
  await bus.producer.send({
    topic,
    acks: -1,
    messages: events.map((e) => {
      const { value, headers } = encodeTradeOpened(e);
      return {
        key: e.followerId,
        value,
        headers,
        ...(partition === undefined ? {} : { partition }),
      };
    }),
  });
}

export interface InProcessWorker {
  readonly id: string;
  readonly consumer: CopyTradeConsumer;
  readonly outcomes: HandleOutcome[];
  stop(): Promise<void>;
}

export async function startWorker(
  bus: Bus,
  options: {
    id: string;
    topic: string;
    groupId: string;
    copyTrades: Pick<CopyTradeService, 'processRequestedEvent'>;
    maxAttempts?: number;
  },
): Promise<InProcessWorker> {
  const kafka = createKafka({ brokers: [bus.brokers], clientId: options.id, logger });
  const producer = createProducer(kafka);
  await producer.connect();
  const metrics = createWorkerMetrics({ collectDefaults: false, instanceId: options.id });
  const outcomes: HandleOutcome[] = [];
  const consumer = new CopyTradeConsumer({
    kafka,
    groupId: options.groupId,
    topic: options.topic,
    logger,
    metrics,
    concurrency: PARTITIONS,
    sessionTimeoutMs: 6_000,
    heartbeatIntervalMs: 300,
    onOutcome: (o) => outcomes.push(o),
    handler: createMessageHandler({
      copyTrades: options.copyTrades,
      output: new KafkaWorkerOutput(producer, options.id),
      workerId: options.id,
      maxAttempts: options.maxAttempts ?? 3,
      retryDelayMs: 10,
      simulatedLatencyMs: 0,
      sleep: (ms) => delay(ms).then(() => undefined),
      logger,
      metrics,
    }),
  });
  await consumer.start();
  return {
    id: options.id,
    consumer,
    outcomes,
    async stop() {
      await consumer.stop();
      await producer.disconnect();
    },
  };
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(100);
  }
}

/** Waits until the group's members together own every partition. */
export const waitForAssignment = (workers: readonly InProcessWorker[]) =>
  waitFor('partition assignment', () => {
    const owned = workers.flatMap((w) => w.consumer.assignedPartitions);
    return owned.length === PARTITIONS && new Set(owned).size === PARTITIONS ? owned : undefined;
  });

/** Reads a topic from the beginning with a throwaway group until `predicate` holds. */
export async function readTopic(
  bus: Bus,
  topic: string,
  predicate: (messages: readonly KafkaMessage[]) => boolean,
  timeoutMs = 30_000,
): Promise<KafkaMessage[]> {
  const consumer = bus.kafka.consumer({ groupId: `reader-${randomUUID()}` });
  const messages: KafkaMessage[] = [];
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: ({ message }) => {
      messages.push(message);
      return Promise.resolve();
    },
  });
  try {
    await waitFor(
      `messages on ${topic}`,
      () => (predicate(messages) ? true : undefined),
      timeoutMs,
    );
    return messages;
  } finally {
    await consumer.disconnect();
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

export interface WorkerProcess {
  readonly id: string;
  readonly process: ChildProcess;
  readonly output: string[];
  readonly metricsUrl: string;
  /** SIGTERM: graceful shutdown (leave the group). Resolves with the exit code. */
  terminate(): Promise<number | null>;
  /** SIGKILL: crash without leaving the group or committing in-flight offsets. */
  kill(): Promise<void>;
}

/** Starts `apps/worker/src/main.ts` as a real OS process. */
export async function spawnWorker(env: Record<string, string>, id: string): Promise<WorkerProcess> {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: WORKER_DIR,
    env: { ...env, INSTANCE_ID: id, METRICS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => output.push(d.toString()));
  const metricsUrl = `http://127.0.0.1:${String(port)}`;
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });

  await waitFor(
    `worker ${id} ready`,
    async () => {
      if (child.exitCode !== null) throw new Error(`worker ${id} exited:\n${output.join('')}`);
      return (await fetch(`${metricsUrl}/health/ready`).then(
        (r) => r.ok,
        () => false,
      ))
        ? true
        : undefined;
    },
    60_000,
  );
  return {
    id,
    process: child,
    output,
    metricsUrl,
    terminate: () => {
      child.kill('SIGTERM');
      return exited;
    },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}
