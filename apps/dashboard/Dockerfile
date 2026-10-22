# Build the Vite SPA, then serve via nginx with same-origin /api proxy.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @waapi/dashboard...

COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
COPY tsconfig.base.json ./

ARG VITE_BRAND_NAME=waapi
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_BRAND_NAME=$VITE_BRAND_NAME
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

RUN pnpm --filter @waapi/shared build \
  && pnpm --filter @waapi/dashboard build

FROM nginx:1.27-alpine
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
