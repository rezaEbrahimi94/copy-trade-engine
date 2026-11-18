import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface WorkerMetrics {
  readonly registry: Registry;
  /** outcome: copied | duplicate | rejected | idempotency_key_conflict | redelivered */
  readonly processed: Counter<'outcome'>;
  readonly deadLettered: Counter<'reason'>;
  readonly retries: Counter;
  readonly duration: Histogram<'outcome'>;
  readonly lag: Gauge<'topic' | 'partition'>;
  readonly lagTotal: Gauge<'topic'>;
  readonly assignedPartitions: Gauge;
  readonly rebalances: Counter;
}

export function createWorkerMetrics(options: {
  collectDefaults: boolean;
  instanceId: string;
}): WorkerMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ instance_id: options.instanceId });
  if (options.collectDefaults) collectDefaultMetrics({ register: registry });
  const registers = [registry];
  return {
    registry,
    processed: new Counter({
      name: 'worker_messages_processed_total',
      help: 'Consumed copy requests by outcome (redelivered = event id already in the inbox)',
      labelNames: ['outcome'],
      registers,
    }),
    deadLettered: new Counter({
      name: 'worker_dead_letters_total',
      help: 'Messages sent to the DLQ by reason (invalid_payload, processing_failed)',
      labelNames: ['reason'],
      registers,
    }),
    retries: new Counter({
      name: 'worker_processing_retries_total',
      help: 'Message processing attempts that failed and were retried',
      registers,
    }),
    duration: new Histogram({
      name: 'worker_message_duration_seconds',
      help: 'Time to process one message including result publication',
      labelNames: ['outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    }),
    lag: new Gauge({
      name: 'kafka_consumer_lag',
      help: 'High watermark minus committed offset, for partitions assigned to this worker',
      labelNames: ['topic', 'partition'],
      registers,
    }),
    lagTotal: new Gauge({
      name: 'kafka_consumer_lag_total',
      help: 'Sum of lag over the partitions assigned to this worker',
      labelNames: ['topic'],
      registers,
    }),
    assignedPartitions: new Gauge({
      name: 'kafka_assigned_partitions',
      help: 'Number of partitions currently assigned to this worker',
      registers,
    }),
    rebalances: new Counter({
      name: 'kafka_consumer_rebalances_total',
      help: 'Consumer group joins (each rebalance assigns partitions anew)',
      registers,
    }),
  };
}
