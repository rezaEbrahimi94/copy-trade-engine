# syntax=docker/dockerfile:1.7
# Build context: repository root (workspace packages are bundled into the worker).
ARG NODE_IMAGE=node:22.23.4-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/messaging/package.json packages/messaging/
COPY packages/platform/package.json packages/platform/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@copy-trade/worker..."
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @copy-trade/worker build \
 && pnpm --filter @copy-trade/worker deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 METRICS_PORT=9100
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
EXPOSE 9100
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=10 \
  CMD wget -qO- "http://127.0.0.1:${METRICS_PORT}/health/ready" >/dev/null || exit 1
# Exec form: node is PID 1 and receives SIGTERM directly, so shutdown leaves the group cleanly.
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
