import {
  HealthResponseSchema,
  InstanceListSchema,
  SystemInfoSchema,
  ReconciliationReportSchema,
  RedriveResponseSchema,
} from '@copy-trade/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { presentInstance, presentReconciliation } from '../presenters';
import type { AppDeps } from '../types';

export const reconciliationRoutes: FastifyPluginAsyncZod<Pick<AppDeps, 'reconciliation'>> = (
  app,
  { reconciliation },
) => {
  app.get(
    '/reconciliation',
    {
      schema: {
        tags: ['operations'],
        summary: 'Verify ledger invariants (read-only; drift is reported, never auto-fixed)',
        response: { 200: ReconciliationReportSchema },
      },
    },
    async () => presentReconciliation(await reconciliation.run()),
  );

  app.post(
    '/reconciliation/redrive',
    {
      schema: {
        tags: ['operations'],
        summary: 'Explicitly re-queue pending executions older than the stuck threshold',
        response: { 200: RedriveResponseSchema },
      },
    },
    async (request) => {
      const requeued = await reconciliation.redriveStuck();
      request.log.warn({ event: 'reconciliation.redrive', requeued }, 'stuck entries re-driven');
      return { requeued };
    },
  );
  return Promise.resolve();
};

export const healthRoutes: FastifyPluginAsyncZod<Pick<AppDeps, 'readinessChecks' | 'metrics'>> = (
  app,
  { readinessChecks, metrics },
) => {
  app.get(
    '/health/live',
    { schema: { tags: ['operations'], response: { 200: HealthResponseSchema } } },
    () => Promise.resolve({ status: 'ok' as const, checks: {} }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['operations'],
        response: { 200: HealthResponseSchema, 503: HealthResponseSchema },
      },
    },
    async (request, reply) => {
      const entries = await Promise.all(
        Object.entries(readinessChecks).map(async ([name, check]) => {
          const healthy = await check().catch((error: unknown) => {
            request.log.warn({ err: error, check: name }, 'readiness check failed');
            return false;
          });
          return [name, healthy ? 'ok' : 'failed'] as const;
        }),
      );
      const checks = Object.fromEntries(entries);
      const ready = entries.every(([, state]) => state === 'ok');
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
    },
  );

  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    return reply
      .header('content-type', metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });
  return Promise.resolve();
};

export const systemRoutes: FastifyPluginAsyncZod<Pick<AppDeps, 'instances' | 'system'>> = (
  app,
  { instances, system },
) => {
  app.get(
    '/instances',
    {
      schema: {
        tags: ['operations'],
        summary: 'API replicas and workers with their last heartbeat and assigned partitions',
        response: { 200: InstanceListSchema },
      },
    },
    async () => ({ items: (await instances.list()).map(presentInstance) }),
  );

  app.get(
    '/system',
    {
      schema: {
        tags: ['operations'],
        summary: 'Serving replica, event bus topics and the Redpanda Console URL',
        response: { 200: SystemInfoSchema },
      },
    },
    () => Promise.resolve(system),
  );
  return Promise.resolve();
};
