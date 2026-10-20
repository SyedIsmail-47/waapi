# Production API image — Node 22, pnpm deploy --prod (no devDependencies).
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @waapi/api...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @waapi/shared build \
 && pnpm --filter @waapi/db build \
 && pnpm --filter @waapi/api build \
 && pnpm --filter @waapi/api deploy --prod --legacy /prod/api \
 && mkdir -p /prod/api/node_modules/@waapi/db/drizzle \
 && cp -R packages/db/drizzle/. /prod/api/node_modules/@waapi/db/drizzle/

# Migrate stage: same API image tree (no host mount)
FROM node:22-bookworm-slim AS migrate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod/api /app
USER node
CMD ["node", "node_modules/@waapi/db/dist/migrate.js"]

FROM node:22-bookworm-slim AS runner
RUN useradd --system --uid 10001 --create-home waapi
WORKDIR /app
ENV NODE_ENV=production
ENV ENABLE_DOCS=false
ENV DEV_RETURN_TOKENS=false
ENV ALLOW_HTTP_WEBHOOKS=false
COPY --from=build --chown=waapi:waapi /prod/api /app
USER waapi
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]
