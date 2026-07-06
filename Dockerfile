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
