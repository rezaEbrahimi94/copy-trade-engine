import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { API_PREFIX } from '@copy-trade/contracts';
import Fastify, { LogController } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { errorBody, errorHandler } from './errors';
import { copyTradeRoutes } from './routes/copy-trades';
import { followerRoutes } from './routes/followers';
import { healthRoutes, reconciliationRoutes } from './routes/operations';
import type { AppDeps } from './types';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Builds the HTTP app from injected dependencies. No I/O happens until `listen`. */
export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => deps.ids.next(),
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      disableRequestLogging: (request) => request.url.startsWith('/health'),
    }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody(request, 'NOT_FOUND', `Route ${request.url} not found`)),
  );

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    deps.metrics.httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  await app.register(cors, { origin: deps.corsOrigin.split(',').map((o) => o.trim()) });
  await app.register(swagger, {
    openapi: { info: { title: 'Copy Trade API', version: '1.0.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(healthRoutes, deps);
  await app.register(followerRoutes, { prefix: API_PREFIX, ...deps });
  await app.register(copyTradeRoutes, { prefix: API_PREFIX, ...deps });
  await app.register(reconciliationRoutes, { prefix: API_PREFIX, ...deps });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
