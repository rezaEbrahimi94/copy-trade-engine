# syntax=docker/dockerfile:1.7
# Build context: repository root (workspace packages are bundled into the API).
ARG NODE_IMAGE=node:22.23.4-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@copy-trade/api..."
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @copy-trade/api build \
 && pnpm --filter @copy-trade/api deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/ready" >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "--import", "./dist/instrumentation.mjs", "dist/main.mjs"]
