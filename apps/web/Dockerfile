# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/brand/package.json packages/brand/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/product-ui/package.json packages/product-ui/package.json
RUN --mount=type=cache,id=sandbox-account-npm,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund --prefer-offline \
      --workspace @sandbox/web --include-workspace-root=false

FROM deps AS contracts-build
COPY packages/contracts packages/contracts
RUN npm run build --workspace @sandbox/contracts

FROM contracts-build AS api-client-build
COPY packages/api-client packages/api-client
RUN npm run build --workspace @sandbox/api-client

FROM api-client-build AS build
COPY apps/web apps/web
COPY packages/brand packages/brand
COPY packages/content packages/content
COPY packages/product-ui packages/product-ui
RUN --mount=type=cache,id=sandbox-account-next,target=/workspace/apps/web/.next/cache \
    npm run build --workspace @sandbox/web

FROM node:20-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3300
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3300
CMD ["node", "apps/web/server.js"]
