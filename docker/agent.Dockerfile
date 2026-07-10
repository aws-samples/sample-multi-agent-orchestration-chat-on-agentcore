# syntax=docker/dockerfile:1.7-labs
# AgentCore Runtime Agent Dockerfile
# Multi-stage build for optimized image size with monorepo workspace support

# ========================================
# Stage 1: Build
# ========================================
FROM public.ecr.aws/docker/library/node:22-slim AS builder

WORKDIR /build

# 1) Root config files
COPY package*.json tsconfig.base.json tsconfig.build.json tsconfig.json ./

# 2) All workspace package.json files, preserving directory structure.
#    .dockerignore excludes any workspace source that is irrelevant to the
#    agent build, so --parents only pulls package.json for needed workspaces.
COPY --parents packages/**/package.json ./
COPY --parents scripts/package.json ./

# 3) Full install (new packages are picked up automatically by the lockfile)
RUN npm ci --ignore-scripts

# 4) Source code (.dockerignore controls what ships into the context)
COPY packages ./packages

# 5) Solution-style build in dependency order for the agent package
RUN npx tsc -b packages/agent --force

# ========================================
# Stage 2: Production
# ========================================
FROM public.ecr.aws/docker/library/node:22-slim

# Install required tools (Python, AWS CLI, GitHub CLI, uv)
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    python3-pip \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI
RUN pip3 install awscli --break-system-packages

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
    tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Install uv/uvx for Python MCP servers
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/uvx /usr/local/bin/uvx && \
    chmod +x /usr/local/bin/uv /usr/local/bin/uvx

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
COPY --chown=node:node --from=builder /build/packages/agent/scripts ./packages/agent/scripts

# Bundled platform skills (moca-guide etc.) — markdown assets, not compiled by
# tsc, so copied verbatim. Must sit at the agent package root, where
# BUNDLED_SKILLS_DIRECTORY (config/index.ts) resolves to `../../skills` from
# dist/config/.
COPY --chown=node:node --from=builder /build/packages/agent/skills ./packages/agent/skills

# Set working directory to agent package
WORKDIR /app/packages/agent

# Make startup script executable
RUN chmod +x scripts/startup.sh

# Expose port 8080
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ping || exit 1

# Run as non-root user for security
USER node

# Start application via entrypoint script
CMD ["./scripts/startup.sh"]
