FROM node:22-bookworm
# Headless Chromium (via Playwright) is baked into the image at a shared,
# world-readable path so any session can screenshot/verify UI work — the
# post-reset container previously had no browser at all.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g @anthropic-ai/claude-code playwright \
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
