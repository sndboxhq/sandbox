# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/marketing/package.json apps/marketing/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/brand/package.json packages/brand/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/product-ui/package.json packages/product-ui/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN --mount=type=cache,id=sandbox-marketing-npm,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund --prefer-offline \
      --workspace @sandbox/marketing --include-workspace-root=false

FROM deps AS contracts-build
COPY packages/contracts packages/contracts
RUN npm run build --workspace @sandbox/contracts

FROM contracts-build AS api-client-build
COPY packages/api-client packages/api-client
RUN npm run build --workspace @sandbox/api-client

FROM api-client-build AS build
COPY apps/marketing apps/marketing
COPY packages/brand packages/brand
COPY packages/content packages/content
COPY packages/product-ui packages/product-ui
COPY packages/ui packages/ui
RUN --mount=type=cache,id=sandbox-marketing-next,target=/workspace/apps/marketing/.next/cache \
    npm run build --workspace @sandbox/marketing

FROM node:20-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3100
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/marketing/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/marketing/.next/static ./apps/marketing/.next/static
COPY --from=build --chown=node:node /workspace/apps/marketing/public ./apps/marketing/public
USER node
EXPOSE 3100
CMD ["node", "apps/marketing/server.js"]
