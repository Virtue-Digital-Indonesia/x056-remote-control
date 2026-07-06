import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModule, type GatewayConfig } from './app.module.js';

const __dir = dirname(fileURLToPath(import.meta.url));

export async function createApp(cfg: GatewayConfig): Promise<INestApplication> {
  if (!cfg.token || cfg.token.length < 24) {
    throw new Error('X056_TOKEN missing or shorter than 24 chars — refusing to start');
  }
  const app = await NestFactory.create(buildModule(cfg) as never, {
    logger: ['warn', 'error'],
    // Base64 screenshots ride in the JSON body; default 100kb is far too small.
    bodyParser: true,
    rawBody: false,
  });
  (app as unknown as { useBodyParser: (t: string, o: { limit: string }) => void }).useBodyParser('json', { limit: '12mb' });
  const express = app.getHttpAdapter().getInstance() as import('express').Express;
  // Read per request so a bind-mounted panelPath serves UI changes without a
  // rebuild; ~15KB from page cache is negligible for a single-user panel.
  const panelPath = cfg.panelPath ?? join(__dir, 'public', 'panel.html');
  express.get('/healthz', (_req, res) => res.json({ ok: true }));
  express.get('/', (_req, res) => {
    try {
      res.type('html').send(readFileSync(panelPath, 'utf8'));
    } catch {
      res.status(500).send('panel unavailable');
    }
  });
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg: GatewayConfig = {
    token: process.env.X056_TOKEN ?? '',
    stateDir: process.env.X056_STATE_DIR ?? join(process.cwd(), 'state'),
    workspaceRoot: process.env.X056_WORKSPACE_ROOT ?? process.cwd(),
    claudePath: process.env.X056_CLAUDE_PATH,
    panelPath: process.env.X056_PANEL_PATH,
  };
  const port = Number(process.env.PORT ?? 4056);
  createApp(cfg)
    .then((app) => app.listen(port, '0.0.0.0'))
    .then(() => console.log(`x056 gateway listening on :${port}`))
    .catch((err) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
