/**
 * OpenTelemetry bootstrap. Load before the app: `node --import ./dist/instrumentation.mjs`.
 * Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set; exports spans for incoming HTTP,
 * Postgres queries (pg) and the manual `copy_trade.process` span. `pg`, `fastify` and `node:http`
 * are loaded through CommonJS `require` (pg and fastify are CJS packages), so require-based
 * patching works without an ESM loader hook.
 */

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

if (endpoint !== undefined && endpoint !== '') {
  const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { PgInstrumentation }] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-pg'),
    ]);

  const sdk = new NodeSDK({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'copy-trade-api',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.once('beforeExit', () => void sdk.shutdown());
}
