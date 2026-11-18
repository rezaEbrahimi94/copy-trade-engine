import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config';
import { startPeriodicTask } from '../../src/infrastructure/periodic-task';
import { SimulatedExecutionGateway } from '../../src/infrastructure/simulated-execution-gateway';
import { createMetrics, createReconciliationObserver } from '../../src/observability/metrics';

const DATABASE_URL = 'postgres://u:p@localhost:5432/db';

describe('loadConfig', () => {
  it('applies defaults and coerces numbers', () => {
    const config = loadConfig({ DATABASE_URL, PORT: '4000', TX_MAX_ATTEMPTS: '7' });
    expect(config).toMatchObject({
      env: 'development',
      http: { host: '127.0.0.1', port: 4000 },
      db: { url: DATABASE_URL, poolMax: 10, migrateOnStart: false },
      retry: { maxAttempts: 7, baseDelayMs: 10 },
      outbox: { pollIntervalMs: 1_000, maxAttempts: 3 },
      otel: { endpoint: undefined },
    });
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ DATABASE_URL, OTEL_EXPORTER_OTLP_ENDPOINT: '', PORT: '' });
    expect(config.otel.endpoint).toBeUndefined();
    expect(config.http.port).toBe(3000);
  });

  it('parses booleans', () => {
    expect(loadConfig({ DATABASE_URL, MIGRATE_ON_START: 'true' }).db.migrateOnStart).toBe(true);
  });

  it.each([
    [{}],
    [{ DATABASE_URL: 'mysql://x' }],
    [{ DATABASE_URL, PORT: '70000' }],
    [{ DATABASE_URL, TX_MAX_ATTEMPTS: '0' }],
    [{ DATABASE_URL, DB_POOL_MAX: 'abc' }],
    [{ DATABASE_URL, MIGRATE_ON_START: 'yes' }],
  ])('rejects invalid environment %o', (env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe('SimulatedExecutionGateway', () => {
  const entry = (tradeId: string) => ({
    id: 'e',
    tradeId,
    traderId: 't',
    followerId: 'f',
    amount: 1,
    status: 'pending' as const,
    idempotencyKey: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it('fails trades with the configured prefix and executes the rest', async () => {
    const gateway = new SimulatedExecutionGateway('fail-');
    expect(await gateway.execute(entry('fail-1'))).toEqual({
      status: 'failed',
      error: 'simulated broker rejection',
    });
    expect(await gateway.execute(entry('ok-1'))).toEqual({ status: 'executed' });
  });
});

describe('startPeriodicTask', () => {
  it('runs repeatedly without overlap, logs failures, and stops cleanly', async () => {
    vi.useFakeTimers();
    const logger = pino({ level: 'silent' });
    const errorSpy = vi.spyOn(logger, 'error');
    let calls = 0;
    const task = startPeriodicTask(
      'test',
      100,
      () => {
        calls += 1;
        return calls === 2 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      logger,
    );

    await vi.advanceTimersByTimeAsync(350);
    expect(calls).toBe(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    await task.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(3);
    vi.useRealTimers();
  });
});

describe('reconciliation observer', () => {
  it('sets gauges and logs drift and stuck entries', async () => {
    const metrics = createMetrics({ collectDefaults: true, instanceId: 'x' });
    const logger = pino({ level: 'silent' });
    const error = vi.spyOn(logger, 'error');
    const warn = vi.spyOn(logger, 'warn');
    const drift = {
      followerId: 'f',
      expectedBalance: 1,
      actualBalance: 2,
      balanceDrift: 1,
      expectedAllocation: 1,
      actualAllocation: 1,
      allocationDrift: 0,
      duplicateKeyCount: 0,
      negative: false,
      consistent: false,
    };

    createReconciliationObserver(metrics, logger).onReport({
      checkedAt: new Date(10_000),
      summary: {
        followersChecked: 3,
        driftedFollowers: 1,
        totalAbsoluteDrift: 1,
        duplicateKeys: 0,
      },
      stuckPending: 2,
      drifted: [drift],
    });

    const text = await metrics.registry.metrics();
    expect(text).toContain('reconciliation_drifted_followers{instance_id="x"} 1');
    expect(text).toContain('reconciliation_stuck_pending{instance_id="x"} 2');
    expect(text).toContain('reconciliation_last_run_timestamp_seconds{instance_id="x"} 10');
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reconciliation.drift', followerId: 'f' }),
      'ledger drift detected',
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
