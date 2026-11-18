import type { EventPublisher, OutboxEvent, ProcessedEvent } from '@copy-trade/application';
import { EVENT_HEADERS, TOPICS } from '@copy-trade/contracts';
import type { Producer } from 'kafkajs';
import { encodeTradeOpened, toResultEvent, type Headers } from './codec';

/** Outbox relay -> `copy-trade.requested`, keyed by follower id. Resolves after all acks. */
export class KafkaEventPublisher implements EventPublisher {
  readonly #producer: Producer;
  readonly #producerId: string;

  constructor(producer: Producer, producerId: string) {
    this.#producer = producer;
    this.#producerId = producerId;
  }

  async publish(events: readonly OutboxEvent[]): Promise<void> {
    const byTopic = new Map<string, OutboxEvent[]>();
    for (const e of events) byTopic.set(e.topic, [...(byTopic.get(e.topic) ?? []), e]);
    await this.#producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, list]) => ({
        topic,
        messages: list.map((e) => {
          const { value, headers } = encodeTradeOpened(e.payload);
          return {
            key: e.key,
            value,
            headers: { ...headers, [EVENT_HEADERS.producer]: this.#producerId },
          };
        }),
      })),
    });
  }
}

export interface DeadLetter {
  readonly key: string | null;
  readonly value: Buffer | null;
  readonly headers: Headers;
  readonly reason: 'invalid_payload' | 'processing_failed';
  readonly error: string;
  readonly attempts: number;
  readonly source: { readonly topic: string; readonly partition: number; readonly offset: string };
}

/** Worker-side output: result events and dead letters. */
export interface WorkerOutput {
  publishResult(record: ProcessedEvent, redelivered: boolean): Promise<void>;
  publishDeadLetter(letter: DeadLetter): Promise<void>;
}

export class KafkaWorkerOutput implements WorkerOutput {
  readonly #producer: Producer;
  readonly #workerId: string;

  constructor(producer: Producer, workerId: string) {
    this.#producer = producer;
    this.#workerId = workerId;
  }

  async publishResult(record: ProcessedEvent, redelivered: boolean): Promise<void> {
    const event = toResultEvent(record, redelivered);
    await this.#producer.send({
      topic: event.type === 'CopyTradeRejected' ? TOPICS.rejected : TOPICS.completed,
      acks: -1,
      messages: [
        {
          key: record.followerId,
          value: JSON.stringify(event),
          headers: {
            [EVENT_HEADERS.eventId]: event.eventId,
            [EVENT_HEADERS.eventType]: event.type,
            [EVENT_HEADERS.causationId]: event.causationId,
            [EVENT_HEADERS.producer]: this.#workerId,
          },
        },
      ],
    });
  }

  async publishDeadLetter(letter: DeadLetter): Promise<void> {
    await this.#producer.send({
      topic: TOPICS.deadLetter,
      acks: -1,
      messages: [
        {
          key: letter.key,
          value: letter.value,
          headers: {
            ...letter.headers,
            [EVENT_HEADERS.dlqReason]: letter.reason,
            [EVENT_HEADERS.dlqError]: letter.error.slice(0, 1_000),
            [EVENT_HEADERS.dlqAttempts]: String(letter.attempts),
            [EVENT_HEADERS.dlqSource]: `${letter.source.topic}/${String(letter.source.partition)}@${letter.source.offset}`,
            [EVENT_HEADERS.producer]: this.#workerId,
          },
        },
      ],
    });
  }
}
