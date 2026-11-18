import { headerString } from '@copy-trade/messaging';
import type { Admin, Consumer, Kafka } from 'kafkajs';
import type { Logger } from 'pino';
import type { HandleOutcome, InboundMessage } from './handler';
import type { WorkerMetrics } from './metrics';

export interface ConsumerOptions {
  readonly kafka: Kafka;
  readonly groupId: string;
  readonly topic: string;
  readonly handler: (message: InboundMessage) => Promise<HandleOutcome>;
  readonly logger: Logger;
  readonly metrics: WorkerMetrics;
  readonly concurrency: number;
  readonly sessionTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly onOutcome?: (outcome: HandleOutcome, message: InboundMessage) => void;
}

/**
 * Consumer-group member for `copy-trade.requested`. Offsets are committed manually, one
 * message at a time, only after the handler resolved (DB transaction committed and result
 * published). A crash before the commit redelivers the message; the inbox makes that harmless.
 */
export class CopyTradeConsumer {
  readonly #options: ConsumerOptions;
  readonly #consumer: Consumer;
  #assigned: number[] = [];
  #joined = false;

  constructor(options: ConsumerOptions) {
    this.#options = options;
    this.#consumer = options.kafka.consumer({
      groupId: options.groupId,
      sessionTimeout: options.sessionTimeoutMs,
      heartbeatInterval: options.heartbeatIntervalMs,
      rebalanceTimeout: options.sessionTimeoutMs * 2,
      allowAutoTopicCreation: false,
    });
  }

  get assignedPartitions(): readonly number[] {
    return this.#assigned;
  }

  get joined(): boolean {
    return this.#joined;
  }

  async start(): Promise<void> {
    const { topic, logger, metrics } = this.#options;
    const { GROUP_JOIN, REBALANCING, CRASH, STOP } = this.#consumer.events;
    this.#consumer.on(GROUP_JOIN, ({ payload }) => {
      this.#joined = true;
      this.#assigned = [...(payload.memberAssignment[topic] ?? [])].sort((a, b) => a - b);
      metrics.rebalances.inc();
      metrics.assignedPartitions.set(this.#assigned.length);
      metrics.lag.reset();
      logger.info(
        {
          event: 'kafka.group_join',
          partitions: this.#assigned,
          leader: payload.isLeader,
          memberId: payload.memberId,
        },
        'joined consumer group',
      );
    });
    this.#consumer.on(REBALANCING, () => {
      logger.info({ event: 'kafka.rebalancing' }, 'consumer group rebalancing');
    });
    this.#consumer.on(CRASH, ({ payload }) => {
      logger.error(
        { event: 'kafka.crash', err: payload.error, restart: payload.restart },
        'consumer crashed',
      );
    });
    this.#consumer.on(STOP, () => {
      this.#joined = false;
      this.#assigned = [];
      metrics.assignedPartitions.set(0);
    });

    await this.#consumer.connect();
    await this.#consumer.subscribe({ topic, fromBeginning: true });
    await this.#consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: this.#options.concurrency,
      eachMessage: async ({ topic: t, partition, message }) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(message.headers ?? {})) {
          const value = headerString(v);
          if (value !== undefined) headers[k] = value;
        }
        const inbound: InboundMessage = {
          topic: t,
          partition,
          offset: message.offset,
          key: message.key?.toString() ?? null,
          value: message.value,
          headers,
        };
        const outcome = await this.#options.handler(inbound);
        await this.#consumer.commitOffsets([
          { topic: t, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
        this.#options.onOutcome?.(outcome, inbound);
      },
    });
  }

  /** Leaves the group (triggering a rebalance) after in-flight messages finish. */
  async stop(): Promise<void> {
    await this.#consumer.disconnect();
  }
}

/** Lag for this worker's partitions: high watermark minus the group's committed offset. */
export async function measureLag(
  admin: Admin,
  groupId: string,
  topic: string,
  partitions: readonly number[],
): Promise<Map<number, number>> {
  const [committed] = await admin.fetchOffsets({ groupId, topics: [topic] });
  const watermarks = await admin.fetchTopicOffsets(topic);
  const lag = new Map<number, number>();
  for (const partition of partitions) {
    const mark = watermarks.find((w) => w.partition === partition);
    if (mark === undefined) continue;
    const offset = Number(
      committed?.partitions.find((p) => p.partition === partition)?.offset ?? '-1',
    );
    const start = offset < 0 ? Number(mark.low) : offset;
    lag.set(partition, Math.max(0, Number(mark.high) - start));
  }
  return lag;
}
