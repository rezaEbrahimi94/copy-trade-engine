import { CopyTradeService, type ProcessedEvent } from '@copy-trade/application';
import {
  FixedClock,
  immediateRetry,
  InMemoryStore,
  SequentialIds,
} from '@copy-trade/application/testing';
import { encodeTradeOpened, type DeadLetter, type WorkerOutput } from '@copy-trade/messaging';
import { pino } from 'pino';
import type { MetricValueWithName } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { createMessageHandler, type HandlerDeps, type InboundMessage } from '../../src/handler';
import { createWorkerMetrics } from '../../src/metrics';

class RecordingOutput implements WorkerOutput {
  readonly results: { record: ProcessedEvent; redelivered: boolean }[] = [];
  readonly deadLetters: DeadLetter[] = [];
  failResults = 0;
  failDeadLetters = false;

  publishResult(record: ProcessedEvent, redelivered: boolean): Promise<void> {
    if (this.failResults > 0) {
      this.failResults -= 1;
      return Promise.reject(new Error('broker unavailable'));
    }
    this.results.push({ record, redelivered });
    return Promise.resolve();
  }

  publishDeadLetter(letter: DeadLetter): Promise<void> {
    if (this.failDeadLetters) return Promise.reject(new Error('dlq unavailable'));
    this.deadLetters.push(letter);
    return Promise.resolve();
  }
}

function setup(overrides: Partial<HandlerDeps> = {}) {
  const store = new InMemoryStore();
  store.followers.set('f1', {
    id: 'f1',
    balance: 1_000,
    remainingAllocation: 1_000,
    openingBalance: 1_000,
    openingAllocation: 1_000,
    copyingEnabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const output = new RecordingOutput();
  const metrics = createWorkerMetrics({ collectDefaults: false, instanceId: 'worker-1' });
  const sleeps: number[] = [];
  const copyTrades = new CopyTradeService({
    unitOfWork: store,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    retry: immediateRetry(),
  });
  const handle = createMessageHandler({
    copyTrades,
    output,
    workerId: 'worker-1',
    maxAttempts: 3,
    retryDelayMs: 100,
    simulatedLatencyMs: 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    logger: pino({ level: 'silent' }),
    metrics,
    ...overrides,
  });
  return { store, output, metrics, sleeps, handle };
}

const message = (eventId = 'evt-1', tradeId = 't1', amount = 700, offset = '5'): InboundMessage => {
  const { value, headers } = encodeTradeOpened({
    eventId,
    type: 'TradeOpened',
    version: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    trade: { id: tradeId, traderId: 'trader', amount },
    followerId: 'f1',
  });
  return {
    topic: 'copy-trade.requested',
    partition: 2,
    offset,
    key: 'f1',
    value: Buffer.from(value),
    headers,
  };
};

const counter = async (metrics: ReturnType<typeof createWorkerMetrics>, name: string) =>
  (await metrics.registry.getSingleMetric(name)?.get())?.values.map((v) => [v.labels, v.value]);

describe('worker message handler', () => {
  it('copies, publishes the result event and records the source partition/offset', async () => {
    const { handle, output, store, metrics } = setup();

    expect(await handle(message())).toEqual({
      kind: 'processed',
      eventId: 'evt-1',
      outcome: 'copied',
      redelivered: false,
    });
    expect(output.results).toEqual([
      {
        redelivered: false,
        record: expect.objectContaining({
          outcome: 'copied',
          handledBy: 'worker-1',
          source: { topic: 'copy-trade.requested', partition: 2, offset: '5' },
        }) as unknown,
      },
    ]);
    expect([...store.trades.values()][0]?.handledBy).toBe('worker-1');
    expect(await counter(metrics, 'worker_messages_processed_total')).toEqual([
      [{ outcome: 'copied' }, 1],
    ]);
  });

  it('redelivery of the same message is harmless and republishes the stored outcome', async () => {
    const { handle, output, store, metrics } = setup();
    await handle(message());

    expect(await handle(message('evt-1', 't1', 700, '9'))).toMatchObject({
      redelivered: true,
      outcome: 'copied',
    });
    expect(store.trades.size).toBe(1);
    expect(store.followers.get('f1')?.balance).toBe(300);
    expect(output.results.map((r) => r.redelivered)).toEqual([false, true]);
    expect(output.results[1]?.record.source?.offset).toBe('5');
    expect(await counter(metrics, 'worker_messages_processed_total')).toEqual([
      [{ outcome: 'copied' }, 1],
      [{ outcome: 'redelivered' }, 1],
    ]);
  });

  it('a second 700 trade on 1,000 / 1,000 is rejected and published as a rejection', async () => {
    const { handle, output } = setup();
    await handle(message('a', 't-a'));
    expect(await handle(message('b', 't-b'))).toMatchObject({ outcome: 'rejected' });
    expect(output.results[1]?.record).toMatchObject({ reason: 'INSUFFICIENT_BALANCE' });
  });

  it('sends invalid payloads straight to the DLQ without processing', async () => {
    const { handle, output, store, metrics } = setup();
    const bad = { ...message(), value: Buffer.from('not json'), offset: '7' };

    expect(await handle(bad)).toEqual({
      kind: 'dead_lettered',
      reason: 'invalid_payload',
      error: 'value is not valid JSON',
      attempts: 0,
    });
    expect(output.deadLetters[0]).toMatchObject({
      reason: 'invalid_payload',
      key: 'f1',
      source: { topic: 'copy-trade.requested', partition: 2, offset: '7' },
    });
    expect(store.processedEvents.size).toBe(0);
    expect(await counter(metrics, 'worker_dead_letters_total')).toEqual([
      [{ reason: 'invalid_payload' }, 1],
    ]);
  });

  it('retries failures with linear backoff; a retry after a lost result publish is idempotent', async () => {
    const { handle, output, store, sleeps, metrics } = setup();
    output.failResults = 2;

    expect(await handle(message())).toMatchObject({ kind: 'processed', redelivered: true });
    expect(sleeps).toEqual([100, 200]);
    expect(store.trades.size).toBe(1);
    expect(output.results).toHaveLength(1);
    expect(await counter(metrics, 'worker_processing_retries_total')).toEqual([[{}, 2]]);
  });

  it('dead-letters after maxAttempts with the last error', async () => {
    const failing = {
      processRequestedEvent: () => Promise.reject(new Error('database unreachable')),
    };
    const { handle, output, sleeps } = setup({ copyTrades: failing });

    expect(await handle(message())).toEqual({
      kind: 'dead_lettered',
      reason: 'processing_failed',
      error: 'database unreachable',
      attempts: 3,
    });
    expect(sleeps).toEqual([100, 200]);
    expect(output.deadLetters[0]).toMatchObject({ attempts: 3, headers: { 'event-id': 'evt-1' } });
  });

  it('stringifies non-Error failures', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const failing = { processRequestedEvent: () => Promise.reject('boom') };
    const { handle } = setup({ copyTrades: failing, maxAttempts: 1 });
    expect(await handle(message())).toMatchObject({ error: 'boom', attempts: 1 });
  });

  it('rejects (no offset commit) when the dead letter cannot be published', async () => {
    const { handle, output } = setup();
    output.failDeadLetters = true;
    await expect(handle({ ...message(), value: null })).rejects.toThrow('dlq unavailable');
  });

  it('applies the simulated latency before processing', async () => {
    const { handle, sleeps } = setup({ simulatedLatencyMs: 250 });
    await handle(message());
    expect(sleeps).toEqual([250]);
  });

  it('emits structured logs and observes the duration in seconds per outcome', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'debug' },
      {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    );
    let clock = 1_000;
    const { handle, output, metrics } = setup({
      logger,
      now: () => (clock += 250),
    });
    output.failResults = 1;

    await handle(message());
    await handle({ ...message(), value: Buffer.from('{}'), offset: '6' });

    expect(lines.find((l) => l['msg'] === 'processing failed, retrying')).toMatchObject({
      level: 40,
      eventId: 'evt-1',
      attempt: 1,
      maxAttempts: 3,
      err: { message: 'broker unavailable' },
    });
    expect(lines.find((l) => l['msg'] === 'copy request processed')).toMatchObject({
      level: 30,
      event: 'worker.processed',
      eventId: 'evt-1',
      tradeId: 't1',
      followerId: 'f1',
      partition: 2,
      offset: '5',
      outcome: 'copied',
      redelivered: true,
      attempt: 2,
    });
    expect(lines.find((l) => l['msg'] === 'message sent to the dead letter topic')).toMatchObject({
      level: 50,
      event: 'worker.dead_letter',
      reason: 'invalid_payload',
      attempts: 0,
      partition: 2,
      offset: '6',
    });
    const histogram = await metrics.registry
      .getSingleMetric('worker_message_duration_seconds')
      ?.get();
    const sum = histogram?.values.find(
      (v) =>
        (v as MetricValueWithName<string>).metricName === 'worker_message_duration_seconds_sum',
    );
    expect(sum).toMatchObject({ labels: { outcome: 'redelivered' }, value: 0.25 });
  });

  it('measures real durations with performance.now() by default', async () => {
    const { handle, metrics } = setup();
    await handle(message());
    const histogram = await metrics.registry
      .getSingleMetric('worker_message_duration_seconds')
      ?.get();
    const sum = histogram?.values.find(
      (v) =>
        (v as MetricValueWithName<string>).metricName === 'worker_message_duration_seconds_sum',
    );
    expect(sum?.value).toBeGreaterThan(0);
    expect(sum?.value).toBeLessThan(5);
  });
});
