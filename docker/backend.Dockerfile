# syntax=docker/dockerfile:1.7-labs
# AgentCore Backend API Dockerfile for AWS Lambda
# Uses Lambda Web Adapter to run the Express server on Lambda
# Multi-stage build with monorepo workspace support

# ========================================
# Stage 1: Build
# ========================================
FROM public.ecr.aws/docker/library/node:22-slim AS builder

WORKDIR /build

# Install tooling required by the build (Python for MCP servers, uv/uvx)
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/uvx /usr/local/bin/uvx && \
    chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# 1) Root config files
COPY package*.json tsconfig.base.json tsconfig.build.json tsconfig.json ./

# 2) All workspace package.json files, preserving directory structure.
COPY --parents packages/**/package.json ./
COPY --parents scripts/package.json ./

# 3) Full install
RUN npm ci --ignore-scripts

# 4) Source code (.dockerignore controls what ships into the context)
COPY packages ./packages

# 5) Solution-style build in dependency order for the backend package
RUN npx tsc -b packages/backend --force

# ========================================
# Stage 2: Production Runtime
# ========================================
FROM public.ecr.aws/docker/library/node:22-slim

# Runtime tools (Python + uv for MCP servers)
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/uvx /usr/local/bin/uvx && \
    chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# Lambda /tmp-compatible uv directories
ENV UV_TOOL_DIR="/tmp/uv_tools"
ENV UV_TOOL_BIN_DIR="/tmp/uv_bin"

# Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /app

# Copy workspace metadata from builder (package.json files only, for npm ci).
# Note the `/./` pivot in --parents sources: BuildKit preserves the path
# relative to the pivot. Without it, files would land at /app/build/... instead
# of /app/....
COPY --chown=node:node --from=builder /build/package*.json ./
COPY --chown=node:node --from=builder --parents /build/./packages/**/package.json ./
COPY --chown=node:node --from=builder --parents /build/./scripts/package.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built artifacts from builder stage (only dist/ folders, preserving structure)
COPY --chown=node:node --from=builder --parents /build/./packages/**/dist ./

# Set working directory to backend package
WORKDIR /app/packages/backend

# Lambda Web Adapter environment variables
ENV PORT=8080
ENV AWS_LWA_PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/ping
ENV AWS_LWA_INVOKE_MODE=BUFFERED
ENV AWS_LWA_ASYNC_INIT=true

# Node.js optimization flags
ENV NODE_ENV=production
ENV AWS_NODEJS_CONNECTION_REUSE_ENABLED=1

RUN chmod +x /opt/extensions/lambda-adapter

# Health check for container image security compliance
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/ping || exit 1

USER node

CMD ["node", "dist/index.js"]
