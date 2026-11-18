import {
  CopyTradeAcceptedSchema,
  CopyTradeHeadersSchema,
  CopyTradeRejectedSchema,
  CopyTradeRequestSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyConflictSchema,
} from '@copy-trade/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withSpan } from '../../observability/tracing';
import { presentFollowerState, presentFollowerTrade, REJECTION_MESSAGES } from '../presenters';
import type { AppDeps } from '../types';

/**
 * POST /copy-trades: validated body + optional Idempotency-Key header -> CopyTradeService.
 * 201 copied | 200 duplicate (original record, same shape) | 404/422 rejected | 409 key reuse.
 */
export const copyTradeRoutes: FastifyPluginAsyncZod<Pick<AppDeps, 'copyTrades' | 'metrics'>> = (
  app,
  { copyTrades, metrics },
) => {
  app.post(
    '/copy-trades',
    {
      schema: {
        tags: ['copy-trades'],
        summary: 'Copy a trade to a follower (idempotent per trade and follower)',
        headers: CopyTradeHeadersSchema,
        body: CopyTradeRequestSchema,
        response: {
          200: CopyTradeAcceptedSchema,
          201: CopyTradeAcceptedSchema,
          400: ErrorResponseSchema,
          404: CopyTradeRejectedSchema,
          409: IdempotencyConflictSchema,
          422: CopyTradeRejectedSchema,
        },
      },
    },
    async (request, reply) => {
      const { trade, followerId } = request.body;
      const idempotencyKey = request.headers[IDEMPOTENCY_KEY_HEADER];

      const result = await withSpan(
        'copy_trade.process',
        { 'trade.id': trade.id, 'follower.id': followerId },
        async (span) => {
          const r = await copyTrades.processCopyTrade({
            trade,
            followerId,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          });
          span.setAttribute('copy_trade.outcome', r.outcome);
          return r;
        },
      );

      switch (result.outcome) {
        case 'copied':
        case 'duplicate': {
          metrics.copyOutcomes.inc({ outcome: result.outcome, reason: '' });
          request.log.info(
            { outcome: result.outcome, tradeId: trade.id, followerId },
            'copy trade processed',
          );
          return reply.code(result.outcome === 'copied' ? 201 : 200).send({
            outcome: result.outcome,
            followerTrade: presentFollowerTrade(result.followerTrade),
            follower: presentFollowerState(result.follower),
          });
        }
        case 'rejected': {
          metrics.copyOutcomes.inc({ outcome: 'rejected', reason: result.reason });
          request.log.info(
            { outcome: 'rejected', reason: result.reason, tradeId: trade.id, followerId },
            'copy trade rejected',
          );
          const body = {
            outcome: 'rejected' as const,
            reason: result.reason,
            message: REJECTION_MESSAGES[result.reason],
          };
          return result.reason === 'FOLLOWER_NOT_FOUND'
            ? reply.code(404).send(body)
            : reply.code(422).send(body);
        }
        case 'idempotency_key_conflict': {
          metrics.copyOutcomes.inc({ outcome: result.outcome, reason: '' });
          return reply.code(409).send({
            outcome: result.outcome,
            message: 'Idempotency-Key was already used for a different trade or follower',
            followerTrade: presentFollowerTrade(result.followerTrade),
          });
        }
      }
    },
  );
  return Promise.resolve();
};
