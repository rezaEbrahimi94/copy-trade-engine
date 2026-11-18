import { z } from 'zod';

const int = (min: number) => z.coerce.number().pipe(z.int().min(min));
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Every tunable comes from the environment and is validated once at startup. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: int(0).pipe(z.int().max(65_535)).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_POOL_MAX: int(1).default(10),
  DB_STATEMENT_TIMEOUT_MS: int(100).default(5_000),
  MIGRATE_ON_START: bool.default(false),
  CORS_ORIGIN: z.string().min(1).default('http://127.0.0.1:5173'),
  LIST_LIMIT: int(1).default(200),
  TX_MAX_ATTEMPTS: int(1).default(5),
  TX_RETRY_BASE_DELAY_MS: int(0).default(10),
  OUTBOX_POLL_INTERVAL_MS: int(0).default(1_000),
  OUTBOX_BATCH_SIZE: int(1).default(20),
  OUTBOX_MAX_ATTEMPTS: int(1).default(3),
  OUTBOX_RETRY_DELAY_MS: int(0).default(2_000),
  RECONCILIATION_INTERVAL_MS: int(0).default(30_000),
  STUCK_PENDING_THRESHOLD_MS: int(0).default(60_000),
  SIMULATED_FAILURE_TRADE_PREFIX: z.string().min(1).default('fail-'),
  OTEL_SERVICE_NAME: z.string().min(1).default('copy-trade-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  INSTANCE_ID: z.string().min(1).default('api-1'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly instanceId: string;
  readonly http: { readonly host: string; readonly port: number; readonly corsOrigin: string };
  readonly log: { readonly level: Env['LOG_LEVEL']; readonly pretty: boolean };
  readonly db: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
    readonly migrateOnStart: boolean;
  };
  readonly listLimit: number;
  readonly retry: { readonly maxAttempts: number; readonly baseDelayMs: number };
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  };
  readonly reconciliation: { readonly intervalMs: number; readonly stuckThresholdMs: number };
  readonly execution: { readonly failureTradePrefix: string };
  readonly otel: { readonly serviceName: string; readonly endpoint: string | undefined };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  // Compose and CI pass unset variables as empty strings; treat them as absent.
  const defined = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(defined);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    instanceId: e.INSTANCE_ID,
    http: { host: e.HOST, port: e.PORT, corsOrigin: e.CORS_ORIGIN },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    db: {
      url: e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      migrateOnStart: e.MIGRATE_ON_START,
    },
    listLimit: e.LIST_LIMIT,
    retry: { maxAttempts: e.TX_MAX_ATTEMPTS, baseDelayMs: e.TX_RETRY_BASE_DELAY_MS },
    outbox: {
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      maxAttempts: e.OUTBOX_MAX_ATTEMPTS,
      retryDelayMs: e.OUTBOX_RETRY_DELAY_MS,
    },
    reconciliation: {
      intervalMs: e.RECONCILIATION_INTERVAL_MS,
      stuckThresholdMs: e.STUCK_PENDING_THRESHOLD_MS,
    },
    execution: { failureTradePrefix: e.SIMULATED_FAILURE_TRADE_PREFIX },
    otel: { serviceName: e.OTEL_SERVICE_NAME, endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT },
  };
}
