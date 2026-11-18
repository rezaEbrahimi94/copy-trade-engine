import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config';

const base = { DATABASE_URL: 'postgres://u:p@db:5432/x', KAFKA_BROKERS: 'redpanda:9092' };

describe('worker config', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      kafka: {
        brokers: ['redpanda:9092'],
        groupId: 'copy-trade-workers',
        requestedPartitions: 6,
        sessionTimeoutMs: 10_000,
      },
      worker: { concurrency: 3, maxAttempts: 3, retryDelayMs: 500, simulatedLatencyMs: 0 },
      http: { host: '127.0.0.1', port: 9100 },
      instanceId: undefined,
    });
  });

  it('parses overrides and ignores empty strings', () => {
    const config = loadConfig({
      ...base,
      KAFKA_BROKERS: 'a:1,b:2',
      WORKER_SIMULATED_LATENCY_MS: '300',
      INSTANCE_ID: '',
      LOG_PRETTY: 'true',
    });
    expect(config.kafka.brokers).toEqual(['a:1', 'b:2']);
    expect(config.worker.simulatedLatencyMs).toBe(300);
    expect(config.instanceId).toBeUndefined();
    expect(config.log.pretty).toBe(true);
  });

  it.each([[{}], [{ ...base, KAFKA_BROKERS: ',' }], [{ ...base, KAFKA_SESSION_TIMEOUT_MS: '10' }]])(
    'rejects invalid environment %o',
    (env) => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );
});
