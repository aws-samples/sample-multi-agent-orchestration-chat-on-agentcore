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

# Install CJK and emoji fonts so local headless Chromium can render Japanese/
# Chinese/Korean text without tofu boxes (□).  This layer is independent of
# npm packages, so routine dependency bumps do not re-download these fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright (and any project-level playwright install) where to store
# browser binaries.  The headless shell pre-installed below will be found here,
# and projects pinned to a different Playwright version can still run
# `npx playwright install chromium` as the node user without root.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

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

# Pre-install headless Chromium and its OS-level shared-library dependencies
# using the playwright-core version that is already resolved by package-lock.json.
# This avoids hard-coding a separate version that could drift from the lockfile.
#
# Why this is needed:
#   - The container runs as USER node (no sudo), so the agent cannot call
#     `apt-get install` or `npx playwright install --with-deps` at runtime.
#   - AgentCore Browser (used by the built-in `browser` tool) is a managed
#     Chrome running on the AWS side — it cannot reach localhost / 127.0.0.1 /
#     file:// inside the agent workspace.  Agents that need to screenshot or
#     test a locally running web app must use this local headless Chromium via
#     execute_command instead.
#
# The `chromium` wrapper on PATH exists because agents discover tools with
# `which chromium`; the real binary sits in a versioned directory outside PATH.
# --no-sandbox: the microVM has no unprivileged user namespaces, so Chromium
# aborts with "No usable sandbox!" without it (Playwright passes the same flag;
# the per-session microVM is the isolation boundary). The stderr filter drops
# ~15 harmless dbus/vaapi/bluetooth/sandbox ERROR lines per run that agents
# otherwise read as failure; --log-level does not suppress them. Real errors
# (e.g. "Page load failed") and the exit code pass through.
RUN node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
    && CHROME_BIN="$(ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell | head -1)" \
    && test -x "$CHROME_BIN" \
    && printf '#!/bin/bash\n{ %s --no-sandbox "$@" 2>&1 1>&3 3>&- | grep -vE ":(ERROR|WARNING):(dbus|media/gpu/vaapi|device/bluetooth|sandbox/policy)/" >&2; } 3>&1\nexit "${PIPESTATUS[0]}"\n' "$CHROME_BIN" > /usr/local/bin/chromium \
    && chmod 755 /usr/local/bin/chromium \
    && chromium --version \
    && chown -R node:node /opt/ms-playwright

# Lets `require('playwright-core')` resolve from the workspace (/tmp/ws), not
# only from /app. NODE_PATH is a fallback, so projects with their own
# node_modules still resolve their own copy first.
ENV NODE_PATH=/app/node_modules

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
