import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('copy-trade-api');

/**
 * Wraps work in an active span. Without a registered SDK (OTEL_EXPORTER_OTLP_ENDPOINT unset)
 * the global tracer is a no-op, so this costs nothing.
 */
export function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
