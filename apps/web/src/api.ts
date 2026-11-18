import {
  API_PREFIX,
  CopyTradeResponseSchema,
  ErrorResponseSchema,
  FollowerListSchema,
  FollowerSchema,
  FollowerTradeListSchema,
  IDEMPOTENCY_KEY_HEADER,
  ReconciliationReportSchema,
  type CopyTradeRequest,
  type CopyTradeResponse,
  type CreateFollowerRequest,
  type ErrorResponse,
  type FollowerDto,
  type FollowerTradeDto,
  type ReconciliationReportDto,
} from '@copy-trade/contracts';
import type { z } from 'zod';

const BASE = `/api${API_PREFIX}`;

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse | undefined;

  constructor(status: number, body: ErrorResponse | undefined) {
    super(body?.error.message ?? `HTTP ${String(status)}`);
    this.status = status;
    this.body = body;
  }
}

async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init: RequestInit = {},
): Promise<z.infer<S>> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const json: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(json);
    throw new ApiError(response.status, parsed.success ? parsed.data : undefined);
  }
  return schema.parse(json);
}

export interface CopyTradeCall {
  readonly status: number;
  readonly body: CopyTradeResponse;
}

export const api = {
  listFollowers: async (): Promise<FollowerDto[]> =>
    (await request(FollowerListSchema, '/followers')).items,

  createFollower: (body: CreateFollowerRequest): Promise<FollowerDto> =>
    request(FollowerSchema, '/followers', { method: 'POST', body: JSON.stringify(body) }),

  setCopying: (id: string, copyingEnabled: boolean): Promise<FollowerDto> =>
    request(FollowerSchema, `/followers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ copyingEnabled }),
    }),

  listTrades: async (id: string): Promise<FollowerTradeDto[]> =>
    (await request(FollowerTradeListSchema, `/followers/${encodeURIComponent(id)}/trades`)).items,

  reconcile: (): Promise<ReconciliationReportDto> =>
    request(ReconciliationReportSchema, '/reconciliation'),

  /** Copy-trade outcomes (including 404/409/422) are part of the contract, not errors. */
  copyTrade: async (body: CopyTradeRequest, idempotencyKey?: string): Promise<CopyTradeCall> => {
    const response = await fetch(`${BASE}/copy-trades`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
      },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json();
    const parsed = CopyTradeResponseSchema.safeParse(json);
    if (!parsed.success) {
      const error = ErrorResponseSchema.safeParse(json);
      throw new ApiError(response.status, error.success ? error.data : undefined);
    }
    return { status: response.status, body: parsed.data };
  },
};
