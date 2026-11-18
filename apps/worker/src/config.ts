import { CONSUMER_GROUP, TOPICS } from '@copy-trade/contracts';
import { z } from 'zod';

const int = (min: number) => z.coerce.number().pipe(z.int().min(min));
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_POOL_MAX: int(1).default(10),
  DB_STATEMENT_TIMEOUT_MS: int(100).default(5_000),
  TX_MAX_ATTEMPTS: int(1).default(5),
  TX_RETRY_BASE_DELAY_MS: int(0).default(10),
  KAFKA_BROKERS: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b !== ''),
    )
    .pipe(z.array(z.string().min(1)).min(1)),
  KAFKA_CLIENT_ID: z.string().min(1).default('copy-trade-worker'),
  KAFKA_REQUESTED_PARTITIONS: int(1).default(6),
  KAFKA_REQUESTED_TOPIC: z.string().min(1).default(TOPICS.requested),
  KAFKA_SESSION_TIMEOUT_MS: int(6_000).default(10_000),
  KAFKA_HEARTBEAT_INTERVAL_MS: int(100).default(1_000),
  CONSUMER_GROUP: z.string().min(1).default(CONSUMER_GROUP),
  WORKER_CONCURRENCY: int(1).default(3),
  WORKER_MAX_ATTEMPTS: int(1).default(3),
  WORKER_RETRY_DELAY_MS: int(0).default(500),
  /** Chaos/demo knob: delay before each message so lag, rebalances and kills are visible. */
  WORKER_SIMULATED_LATENCY_MS: int(0).default(0),
  HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_PORT: int(0).pipe(z.int().max(65_535)).default(9100),
  LAG_INTERVAL_MS: int(0).default(2_000),
  HEARTBEAT_INTERVAL_MS: int(0).default(2_000),
  INSTANCE_ID: z.string().min(1).optional(),
});

export interface WorkerConfig {
  readonly log: { readonly level: string; readonly pretty: boolean };
  readonly db: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
  };
  readonly retry: { readonly maxAttempts: number; readonly baseDelayMs: number };
  readonly kafka: {
    readonly brokers: readonly string[];
    readonly clientId: string;
    readonly requestedPartitions: number;
    readonly requestedTopic: string;
    readonly sessionTimeoutMs: number;
    readonly heartbeatIntervalMs: number;
    readonly groupId: string;
  };
  readonly worker: {
    readonly concurrency: number;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
    readonly simulatedLatencyMs: number;
  };
  readonly http: { readonly host: string; readonly port: number };
  readonly lagIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly instanceId: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(source: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const defined = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(defined);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    db: {
      url: e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    },
    retry: { maxAttempts: e.TX_MAX_ATTEMPTS, baseDelayMs: e.TX_RETRY_BASE_DELAY_MS },
    kafka: {
      brokers: e.KAFKA_BROKERS,
      clientId: e.KAFKA_CLIENT_ID,
      requestedPartitions: e.KAFKA_REQUESTED_PARTITIONS,
      requestedTopic: e.KAFKA_REQUESTED_TOPIC,
      sessionTimeoutMs: e.KAFKA_SESSION_TIMEOUT_MS,
      heartbeatIntervalMs: e.KAFKA_HEARTBEAT_INTERVAL_MS,
      groupId: e.CONSUMER_GROUP,
    },
    worker: {
      concurrency: e.WORKER_CONCURRENCY,
      maxAttempts: e.WORKER_MAX_ATTEMPTS,
      retryDelayMs: e.WORKER_RETRY_DELAY_MS,
      simulatedLatencyMs: e.WORKER_SIMULATED_LATENCY_MS,
    },
    http: { host: e.HOST, port: e.METRICS_PORT },
    lagIntervalMs: e.LAG_INTERVAL_MS,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    instanceId: e.INSTANCE_ID,
  };
}
