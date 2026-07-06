FROM node:22-bookworm
RUN npm install -g @anthropic-ai/claude-code \
 && apt-get update && apt-get install -y --no-install-recommends ripgrep curl openssh-client \
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
RUN mkdir -p /app/state && ln -sfn /app/state/ssh /home/efran/.ssh
ENV PORT=4056
EXPOSE 4056
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:4056/healthz || exit 1
CMD ["npx", "tsx", "server/main.ts"]
