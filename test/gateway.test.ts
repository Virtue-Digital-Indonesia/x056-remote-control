import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import { createApp } from '../server/main.js';

const FAKE = new URL('./bin/fake-claude', import.meta.url).pathname;
const TOKEN = 'test-token-0123456789abcdefghij';

let app: INestApplication;
let base = '';
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'x056-gw-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [
    { name: 'a', configDir: join(dir, 'cfg-a') },
    { name: 'b', configDir: join(dir, 'cfg-b') },
  ]);
  const scenarioA = join(dir, 'a.jsonl');
  writeFileSync(scenarioA, [
    JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'gw' } }),
    JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } } }),
    JSON.stringify({ delayMs: 20 }),
    JSON.stringify({ event: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' } }),
    JSON.stringify({ hang: true }),
  ].join('\n'));
  const scenarioB = join(dir, 'b.jsonl');
  writeFileSync(scenarioB, [
    JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: 'finishing on b' }] } } }),
    JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'done on b' } }),
    JSON.stringify({ exit: 0 }),
  ].join('\n'));
  process.env.X056_FAKE_SCENARIO = scenarioA;
  process.env.X056_FAKE_SCENARIO_RESUME = scenarioB;

  app = await createApp({ token: TOKEN, stateDir, workspaceRoot: dir, claudePath: FAKE });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  delete process.env.X056_FAKE_SCENARIO;
  delete process.env.X056_FAKE_SCENARIO_RESUME;
  await app?.close();
});

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

describe('gateway e2e', () => {
  it('healthz is open, api is locked', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/api/accounts`)).status).toBe(401);
    expect((await fetch(`${base}/api/accounts`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('serves the panel unauthenticated with no token inside', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('x056');
    expect(html).not.toContain(TOKEN);
  });

  it('runs a full failover session over HTTP + SSE', async () => {
    const started = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'do the task' }) });
    expect(started.status).toBe(201);
    const { sessionId } = (await started.json()) as { sessionId: string };
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);

    // busy guard
    const busy = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'nope' }) });
    expect(busy.status).toBe(409);

    // SSE via query token
    const stream = await fetch(`${base}/api/sessions/current/stream?token=${TOKEN}`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const t0 = Date.now();
    while (!text.includes('session_done') && Date.now() - t0 < 15000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    expect(text).toContain('assistant_text');
    expect(text).toContain('working on it');
    expect(text).toContain('failover');
    expect(text).toContain('finishing on b');
    expect(text).toContain('session_done');
  }, 20000);

  it('accounts endpoint returns registry state with quota errors handled gracefully', async () => {
    const res = await fetch(`${base}/api/accounts`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; state: unknown; quota: unknown; quotaError?: string }[];
    expect(body.map((a) => a.name)).toEqual(['a', 'b']);
    expect(body[0].quotaError).toBeTruthy(); // fake cfg dirs have no credentials
  });

  it('switch returns 409 when idle', async () => {
    const res = await fetch(`${base}/api/switch`, { method: 'POST', headers: auth });
    expect(res.status).toBe(409);
  });

  it('cwd outside workspace root is a 400', async () => {
    const res = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'x', cwd: '/etc' }) });
    expect(res.status).toBe(400);
  });
});

describe('gateway adoption endpoint', () => {
  it('rejects an unknown session with 400', async () => {
    const res = await fetch(`${base}/api/sessions/current`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'ghost', cwd: dir }),
    });
    expect(res.status).toBe(400);
  });

  it('adopts a seeded transcript and reflects it in the snapshot', async () => {
    const munged = dir.replace(/[/.]/g, '-');
    mkdirSync(join(dir, 'cfg-a', 'projects', munged), { recursive: true });
    writeFileSync(join(dir, 'cfg-a', 'projects', munged, 'adopted-1.jsonl'), '{"type":"user"}\n');
    const res = await fetch(`${base}/api/sessions/current`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'adopted-1', cwd: dir }),
    });
    expect(res.status).toBe(200);
    const snap = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { lastSessionId: string };
    expect(snap.lastSessionId).toBe('adopted-1');
  });
});

describe('live panel path', () => {
  it('serves panel content per-request so edits appear without restart', async () => {
    const pdir = mkdtempSync(join(tmpdir(), 'x056-panel-'));
    const panelFile = join(pdir, 'panel.html');
    writeFileSync(panelFile, '<html><body>x056 v1</body></html>');
    const app2 = await createApp({ token: TOKEN, stateDir: join(pdir, 'state'), workspaceRoot: pdir, panelPath: panelFile });
    await app2.listen(0);
    const url = await app2.getUrl();
    try {
      expect(await (await fetch(`${url}/`)).text()).toContain('x056 v1');
      writeFileSync(panelFile, '<html><body>x056 v2 themed</body></html>');
      expect(await (await fetch(`${url}/`)).text()).toContain('x056 v2 themed');
    } finally {
      await app2.close();
    }
  });
});
