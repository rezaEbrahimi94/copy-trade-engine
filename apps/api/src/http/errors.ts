import type { ErrorResponse } from '@copy-trade/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export const errorBody = (
  request: FastifyRequest,
  code: string,
  message: string,
): ErrorResponse => ({ error: { code, message, requestId: request.id } });

/** Maps every unhandled error to the shared ErrorResponse contract; 5xx details stay in logs. */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply
      .code(400)
      .send(
        errorBody(
          request,
          'VALIDATION_ERROR',
          error.validation
            .map((v) => `${v.instancePath || '/'} ${v.message ?? ''}`.trim())
            .join('; '),
        ),
      );
  }
  const status = error.statusCode ?? 500;
  if (status < 500) {
    return reply.code(status).send(errorBody(request, error.code, error.message));
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send(errorBody(request, 'INTERNAL_ERROR', 'Internal server error'));
}
