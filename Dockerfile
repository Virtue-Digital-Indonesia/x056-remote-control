FROM node:22-bookworm
# Headless Chromium (via Playwright) is baked into the image at a shared,
# world-readable path so any session can screenshot/verify UI work — the
# post-reset container previously had no browser at all.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# @openai/codex is the second failover provider (ChatGPT-plan GPT models); the
# gateway spawns `codex exec --json` alongside `claude` for codex projects.
# claude-code is pinned so a rebuild actually re-runs this (otherwise Docker
# reuses the cached layer and the CLI silently stays stale); bump it to pick up
# new models (e.g. Claude Opus 5) and fixes.
RUN npm install -g @anthropic-ai/claude-code@2.1.245 @openai/codex playwright \
 && apt-get update && apt-get install -y --no-install-recommends ripgrep curl openssh-client \
 && npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*
# Language toolchains for the workspace's projects so ANY session can build/test
# in its own project, not only Node ones (Go, Java+Maven, Python pip/venv,
# PHP+Composer; gcc/make already present). Go uses GOTOOLCHAIN=auto so a project
# pinning a newer patch is fetched on demand.
ENV GOTOOLCHAIN=auto GOPATH=/home/efran/go
ENV PATH="/usr/local/go/bin:/home/efran/go/bin:${PATH}"
RUN set -eux; \
    GO_VERSION="$(curl -fsSL https://go.dev/VERSION?m=text | head -1)"; \
    curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz; \
    tar -C /usr/local -xzf /tmp/go.tgz; rm /tmp/go.tgz; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless maven python3-pip python3-venv php-cli unzip zip jq; \
    curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php; \
    php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer; \
    rm -f /tmp/composer-setup.php; \
    rm -rf /var/lib/apt/lists/*
# Docker CLI + compose plugin ONLY (no daemon). A project session drives the
# isolated dind sidecar via DOCKER_HOST (see compose.yaml) for its own builds and
# compose e2e stacks — the host's Docker is never touched.
RUN install -m0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin; \
    rm -rf /var/lib/apt/lists/*
# Bun — a separate JS/TS runtime + package manager some projects use directly
# (bun install/bun test/bun run), independent of the system Node above. Shared,
# world-readable location, same pattern as Go.
ENV BUN_INSTALL=/usr/local/share/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
RUN curl -fsSL https://bun.sh/install | bash \
 && chmod -R a+rX "${BUN_INSTALL}"
RUN useradd -m -u 1001 efran
USER efran
WORKDIR /app
COPY --chown=efran:efran package.json package-lock.json ./
RUN npm ci
COPY --chown=efran:efran . .
# Pre-create the state mountpoint so the named volume inherits efran ownership,
# and point ~/.ssh at the dedicated key material kept in that persistent volume
# (state/ssh/: scoped key + pinned known_hosts + config for the VPN target).
RUN mkdir -p /app/state && rm -rf /home/efran/.ssh && ln -s /app/state/ssh /home/efran/.ssh
ENV PORT=4056
EXPOSE 4056
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:4056/healthz || exit 1
CMD ["npx", "tsx", "server/main.ts"]
