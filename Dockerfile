FROM node:22-bookworm
RUN npm install -g @anthropic-ai/claude-code \
 && apt-get update && apt-get install -y --no-install-recommends ripgrep curl \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 efran
USER efran
WORKDIR /app
COPY --chown=efran:efran package.json package-lock.json ./
RUN npm ci
COPY --chown=efran:efran . .
# Pre-create the state mountpoint so the named volume inherits efran ownership
RUN mkdir -p /app/state
ENV PORT=4056
EXPOSE 4056
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:4056/healthz || exit 1
CMD ["npx", "tsx", "server/main.ts"]
