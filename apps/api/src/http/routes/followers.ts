import {
  CreateFollowerRequestSchema,
  ErrorResponseSchema,
  FollowerListSchema,
  FollowerParamsSchema,
  FollowerSchema,
  FollowerTradeListSchema,
  UpdateFollowerRequestSchema,
} from '@copy-trade/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { presentFollower, presentFollowerTrade } from '../presenters';
import { errorBody } from '../errors';
import type { AppDeps } from '../types';

export const followerRoutes: FastifyPluginAsyncZod<Pick<AppDeps, 'followers'>> = (
  app,
  { followers },
) => {
  app.post(
    '/followers',
    {
      schema: {
        tags: ['followers'],
        body: CreateFollowerRequestSchema,
        response: { 201: FollowerSchema, 400: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await followers.create(request.body);
      if (!result.ok) {
        return reply.code(400).send(errorBody(request, result.reason, 'Invalid follower amounts'));
      }
      return reply.code(201).send(presentFollower(result.follower));
    },
  );

  app.get(
    '/followers',
    { schema: { tags: ['followers'], response: { 200: FollowerListSchema } } },
    async () => ({ items: (await followers.list()).map(presentFollower) }),
  );

  app.get(
    '/followers/:followerId',
    {
      schema: {
        tags: ['followers'],
        params: FollowerParamsSchema,
        response: { 200: FollowerSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const follower = await followers.get(request.params.followerId);
      if (follower === undefined) {
        return reply.code(404).send(errorBody(request, 'NOT_FOUND', 'Follower not found'));
      }
      return presentFollower(follower);
    },
  );

  app.patch(
    '/followers/:followerId',
    {
      schema: {
        tags: ['followers'],
        params: FollowerParamsSchema,
        body: UpdateFollowerRequestSchema,
        response: { 200: FollowerSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const follower = await followers.setCopyingEnabled(
        request.params.followerId,
        request.body.copyingEnabled,
      );
      if (follower === undefined) {
        return reply.code(404).send(errorBody(request, 'NOT_FOUND', 'Follower not found'));
      }
      return presentFollower(follower);
    },
  );

  app.get(
    '/followers/:followerId/trades',
    {
      schema: {
        tags: ['followers'],
        params: FollowerParamsSchema,
        response: { 200: FollowerTradeListSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const trades = await followers.listTrades(request.params.followerId);
      if (trades === undefined) {
        return reply.code(404).send(errorBody(request, 'NOT_FOUND', 'Follower not found'));
      }
      return { items: trades.map(presentFollowerTrade) };
    },
  );
  return Promise.resolve();
};
