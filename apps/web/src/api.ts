import {
  API_PREFIX,
  CopyTradeResponseSchema,
  ErrorResponseSchema,
  FollowerListSchema,
  FollowerSchema,
  FollowerTradeListSchema,
  IDEMPOTENCY_KEY_HEADER,
  INSTANCE_ID_HEADER,
  InstanceListSchema,
  OpenTradeResponseSchema,
  ReconciliationReportSchema,
  RepublishResponseSchema,
  SystemInfoSchema,
  TradeViewSchema,
  type CopyTradeRequest,
  type CopyTradeResponse,
  type CreateFollowerRequest,
  type ErrorResponse,
  type FollowerDto,
  type FollowerTradeDto,
  type InstanceDto,
  type OpenTradeRequest,
  type OpenTradeResponse,
  type ReconciliationReportDto,
  type SystemInfo,
  type TradeViewDto,
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

type InstanceListener = (instanceId: string) => void;
const listeners = new Set<InstanceListener>();

/** Notified with the `x-instance-id` of every API response (which replica served it). */
export function onInstance(listener: InstanceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function send(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const instanceId = response.headers.get(INSTANCE_ID_HEADER);
  if (instanceId !== null) for (const l of listeners) l(instanceId);
  const json: unknown = await response.json();
  return { response, json, instanceId };
}

async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init: RequestInit = {},
): Promise<z.infer<S>> {
  const { response, json } = await send(path, init);
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(json);
    throw new ApiError(response.status, parsed.success ? parsed.data : undefined);
  }
  return schema.parse(json);
}

/** A response whose non-2xx statuses are part of the contract, tagged with the serving replica. */
async function contractCall<S extends z.ZodType>(schema: S, path: string, init: RequestInit) {
  const { response, json, instanceId } = await send(path, init);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const error = ErrorResponseSchema.safeParse(json);
    throw new ApiError(response.status, error.success ? error.data : undefined);
  }
  return { status: response.status, body: parsed.data, instanceId };
}

export interface CopyTradeCall {
  readonly status: number;
  readonly body: CopyTradeResponse;
  readonly instanceId: string | null;
}

export interface OpenTradeCall {
  readonly status: number;
  readonly body: OpenTradeResponse;
  readonly instanceId: string | null;
}

export const api = {
  listFollowers: async (): Promise<FollowerDto[]> =>
    (await request(FollowerListSchema, '/followers')).items,

  getFollower: (id: string): Promise<FollowerDto> =>
    request(FollowerSchema, `/followers/${encodeURIComponent(id)}`),

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
  copyTrade: (body: CopyTradeRequest, idempotencyKey?: string): Promise<CopyTradeCall> =>
    contractCall(CopyTradeResponseSchema, '/copy-trades', {
      method: 'POST',
      headers: idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: JSON.stringify(body),
    }),

  /** Event-driven path: 202 accepted / 200 duplicate / 409 conflict. */
  openTrade: (body: OpenTradeRequest): Promise<OpenTradeCall> =>
    contractCall(OpenTradeResponseSchema, '/trades', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getTrade: (id: string): Promise<TradeViewDto> =>
    request(TradeViewSchema, `/trades/${encodeURIComponent(id)}`),

  republish: async (id: string): Promise<number> =>
    (
      await request(RepublishResponseSchema, `/trades/${encodeURIComponent(id)}/republish`, {
        method: 'POST',
        body: '{}',
      })
    ).republished,

  instances: async (): Promise<InstanceDto[]> =>
    (await request(InstanceListSchema, '/instances')).items,

  system: (): Promise<SystemInfo> => request(SystemInfoSchema, '/system'),
};
