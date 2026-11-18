import { Kafka, logLevel, Partitioners, type Admin, type Producer } from 'kafkajs';
import type { Logger } from 'pino';

export interface KafkaOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly logger: Logger;
}

const LEVELS: Record<number, 'error' | 'warn' | 'info' | 'debug'> = {
  [logLevel.ERROR]: 'error',
  [logLevel.WARN]: 'warn',
  [logLevel.INFO]: 'info',
  [logLevel.DEBUG]: 'debug',
};

/** kafkajs client whose logs go through pino as structured JSON. */
export function createKafka({ brokers, clientId, logger }: KafkaOptions): Kafka {
  const log = logger.child({ component: 'kafkajs' });
  return new Kafka({
    clientId,
    brokers: [...brokers],
    logLevel: logLevel.WARN,
    retry: { retries: 8, initialRetryTime: 200 },
    logCreator:
      () =>
      ({ level, log: entry }) => {
        const { message, ...rest } = entry;
        log[LEVELS[level] ?? 'info'](rest, message);
      },
  });
}

/**
 * Idempotent producer (broker-side dedupe of retried sends within a session) waiting for all
 * in-sync replicas. It is not exactly-once end to end; consumers still dedupe on event id.
 */
export function createProducer(kafka: Kafka): Producer {
  return kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
}

export interface TopicLayout {
  readonly requestedPartitions: number;
  readonly resultPartitions: number;
}

/** Creates the topics if missing; safe to call from every process at startup. */
export async function ensureTopics(
  admin: Admin,
  layout: TopicLayout,
  topics: {
    readonly requested: string;
    readonly completed: string;
    readonly rejected: string;
    readonly deadLetter: string;
  },
): Promise<void> {
  const existing = new Set(await admin.listTopics());
  const wanted = [
    { topic: topics.requested, numPartitions: layout.requestedPartitions },
    { topic: topics.completed, numPartitions: layout.resultPartitions },
    { topic: topics.rejected, numPartitions: layout.resultPartitions },
    { topic: topics.deadLetter, numPartitions: 1 },
  ].filter((t) => !existing.has(t.topic));
  if (wanted.length === 0) return;
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: wanted.map((t) => ({ ...t, replicationFactor: -1 })),
    });
  } catch (error) {
    // Another process created them concurrently.
    if (!(error instanceof Error && /already exists/i.test(error.message))) throw error;
  }
}
