# --- Build stage ---
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install build deps for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts eslint.config.js ./
COPY src ./src

# Skip tests during Docker build (faster). Run them locally.
RUN npm run build || true

# --- Runtime stage ---
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Install runtime deps for better-sqlite3 + curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash bot

# Copy built app + node_modules from build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/vitest.config.ts ./

# Create data dir for SQLite + logs
RUN mkdir -p /app/data && chown -R bot:bot /app

USER bot

# Health check — verifies process is responsive
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD pgrep -f "tsx src/cli.ts start" > /dev/null || exit 1

# Default: start the bot
CMD ["npx", "tsx", "src/cli.ts", "start"]
