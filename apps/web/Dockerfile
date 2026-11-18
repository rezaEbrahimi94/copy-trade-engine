# syntax=docker/dockerfile:1.7
# Build context: repository root (the UI imports the shared contracts package).
ARG NODE_IMAGE=node:22.23.4-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@copy-trade/web..."
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @copy-trade/web build

FROM nginx:1.29-alpine AS runtime
ENV API_UPSTREAM=http://api:3000
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
