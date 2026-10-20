FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @waapi/worker...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker
RUN pnpm --filter @waapi/shared build \
 && pnpm --filter @waapi/db build \
 && pnpm --filter @waapi/worker build \
 && pnpm --filter @waapi/worker --prod deploy /prod/worker

FROM node:22-bookworm-slim AS runner
RUN useradd --system --uid 10001 --create-home waapi
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=waapi:waapi /prod/worker /app
USER waapi
EXPOSE 9091
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_METRICS_PORT||9091)+'/metrics').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
