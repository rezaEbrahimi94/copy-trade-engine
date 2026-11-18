import {
  ErrorResponseSchema,
  OpenTradeAcceptedSchema,
  OpenTradeRequestSchema,
  RepublishResponseSchema,
  TradeConflictSchema,
  TradeParamsSchema,
  TradeViewListSchema,
  TradeViewSchema,
} from '@copy-trade/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withSpan } from '../../observability/tracing';
import { errorBody } from '../errors';
import { presentTradeRecord, presentTradeView, REJECTION_MESSAGES } from '../presenters';
import type { AppDeps } from '../types';

/**
 * Event-driven entry point: POST /trades stores the trade and its fan-out events in one
 * transaction (202). Workers copy it asynchronously; GET /trades/:id shows the outcomes.
 */
export const tradeRoutes: FastifyPluginAsyncZod<Pick<AppDeps, 'trades' | 'metrics'>> = (
  app,
  { trades, metrics },
) => {
  app.post(
    '/trades',
    {
      schema: {
        tags: ['trades'],
        summary: 'Open a trade; copy requests are published to the bus for each eligible follower',
        body: OpenTradeRequestSchema,
        response: {
          200: OpenTradeAcceptedSchema,
          202: OpenTradeAcceptedSchema,
          400: ErrorResponseSchema,
          409: TradeConflictSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await withSpan('trade.open', { 'trade.id': request.body.id }, () =>
        trades.openTrade(request.body),
      );
      metrics.tradesOpened.inc({ outcome: result.outcome });
      switch (result.outcome) {
        case 'invalid_amount':
          return reply
            .code(400)
            .send(errorBody(request, 'INVALID_AMOUNT', REJECTION_MESSAGES.INVALID_AMOUNT));
        case 'trade_conflict':
          return reply.code(409).send({
            outcome: result.outcome,
            message: 'Trade id already used with a different trader or amount',
            trade: presentTradeRecord(result.trade),
          });
        case 'accepted':
        case 'duplicate':
          request.log.info(
            {
              outcome: result.outcome,
              tradeId: result.trade.id,
              followers: result.requestedFollowerIds.length,
            },
            'trade opened',
          );
          return reply.code(result.outcome === 'accepted' ? 202 : 200).send({
            outcome: result.outcome,
            trade: presentTradeRecord(result.trade),
            requestedFollowerIds: [...result.requestedFollowerIds],
          });
      }
    },
  );

  app.get(
    '/trades',
    { schema: { tags: ['trades'], response: { 200: TradeViewListSchema } } },
    async () => ({ items: (await trades.list()).map(presentTradeView) }),
  );

  app.get(
    '/trades/:tradeId',
    {
      schema: {
        tags: ['trades'],
        params: TradeParamsSchema,
        response: { 200: TradeViewSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const view = await trades.get(request.params.tradeId);
      if (view === undefined) {
        return reply.code(404).send(errorBody(request, 'NOT_FOUND', 'Trade not found'));
      }
      return presentTradeView(view);
    },
  );

  app.post(
    '/trades/:tradeId/republish',
    {
      schema: {
        tags: ['trades'],
        summary: 'Publish the original copy requests again (same event ids): forced redelivery',
        params: TradeParamsSchema,
        response: { 202: RepublishResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const republished = await trades.republish(request.params.tradeId);
      if (republished === undefined) {
        return reply.code(404).send(errorBody(request, 'NOT_FOUND', 'Trade not found'));
      }
      request.log.warn(
        { event: 'trade.republish', tradeId: request.params.tradeId, republished },
        'redelivery forced',
      );
      return reply.code(202).send({ republished });
    },
  );
  return Promise.resolve();
};
