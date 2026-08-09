# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Builder — compiles the client bundle, the server output and the native addons
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

# `prepare` runs husky, which has no git repository to hook into at this stage.
ENV HUSKY=0

WORKDIR /app

# node-pty and better-sqlite3 build native addons through node-gyp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# `postinstall` executes scripts/fix-node-pty.js, so the script has to be in
# place before `npm ci` runs — copying package files alone would break install.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build

# Native addons are already compiled; pruning only drops dev dependencies.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Runtime — no toolchain, no sources, unprivileged user
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Pinned by the CI at build time so an image rebuild is explicit rather than a
# silent upgrade on every container restart.
ARG CLAUDE_CLI_VERSION=latest

# Lets the deploy prune its own superseded images without touching anything
# else on a host that may run unrelated containers.
LABEL org.opencontainers.image.title="CloudCLI"

ENV NODE_ENV=production \
    SERVER_PORT=3001 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/home/node/.cloudcli/auth.db \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    HOME=/home/node

# git and openssh-client are what makes the remote workspace usable at all;
# ripgrep backs the in-app search when @vscode/ripgrep cannot fetch its binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client ripgrep tini less gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
 && npm cache clean --force

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/dist-server ./dist-server
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/shared ./shared
# findAppRoot() resolves the app root by walking up to this file — the server
# reads its running version from it at startup.
COPY --from=builder --chown=node:node /app/package.json ./package.json

RUN install -d -o node -g node /home/node/.cloudcli /home/node/.claude /workspace

USER node
EXPOSE 3001

# /api/auth/status is unauthenticated and touches SQLite, so a healthy response
# proves both the HTTP layer and the database are actually up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/auth/status" || exit 1

# node-pty spawns shells; tini reaps them instead of leaving zombies behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist-server/server/index.js"]
