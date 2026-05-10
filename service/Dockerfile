# File Server Dockerfile
FROM oven/bun:1.3.13 AS base
WORKDIR /app

# Install dependencies and build workspace lib
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
COPY lib /temp/dev/lib
RUN cd /temp/dev/lib/api-keys && bun install --ignore-scripts && bun run build
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
COPY lib /temp/prod/lib
RUN cd /temp/prod/lib/api-keys && bun install --ignore-scripts && bun run build
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Build all entry points
FROM base AS builder
COPY --from=install /temp/dev/node_modules node_modules
COPY --from=install /temp/dev/lib ./lib
COPY src ./src
COPY tsconfig.json ./
RUN bun build ./src/file-server.ts --minify --outdir .build --target bun
RUN bun build ./src/api-server.ts --minify --outdir .build-api --target bun
RUN bun build ./src/worker-server.ts --minify --outdir .build-worker --target bun
RUN bun build ./src/egress-gateway.ts --minify --outdir .build-egress-gateway --target bun

# File server production
FROM oven/bun:1.3.13 AS production
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build ./.build
CMD ["bun", "run", ".build/file-server.js"]

# API server (HTTP on port 3112)
FROM oven/bun:1.3.13 AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build-api ./.build-api
COPY --from=builder /app/src/*.py ./src/
CMD ["bun", "run", ".build-api/api-server.js"]

# Worker server (job processor, health on port 3113)
FROM oven/bun:1.3.13 AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build-worker ./.build-worker
COPY --from=builder /app/src/*.py ./src/
CMD ["bun", "run", ".build-worker/worker-server.js"]

# Egress gateway (sandbox outbound delegation)
FROM oven/bun:1.3.13 AS egress-gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=builder /app/.build-egress-gateway ./.build-egress-gateway
CMD ["bun", "run", ".build-egress-gateway/egress-gateway.js"]

# Development stage  
FROM base AS development
ENV NODE_ENV=development
COPY --from=install /temp/dev/node_modules node_modules
COPY --from=install /temp/dev/lib ./lib
COPY src ./src
COPY tsconfig.json ./
EXPOSE 3000 9230
CMD ["bun", "run", "--watch", "src/file-server.ts"]
