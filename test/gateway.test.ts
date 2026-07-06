import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
  mkdirSync(join(dir, 'cfg-a'), { recursive: true });
  writeFileSync(join(dir, 'cfg-a', '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Alpha', emailAddress: 'alpha@example.com' } }));
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

/** Wait until no session is running so a test doesn't leak work into the next. */
async function idle(timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const s = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { running: boolean };
    if (!s.running) return;
    if (Date.now() - t0 > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

describe('gateway account identity + image upload', () => {
  it('accounts include displayName/email read from .claude.json', async () => {
    const body = await (await fetch(`${base}/api/accounts`, { headers: auth })).json() as { name: string; displayName?: string; email?: string }[];
    const a = body.find((x) => x.name === 'a');
    expect(a?.displayName).toBe('Alpha');
    expect(a?.email).toBe('alpha@example.com');
  });

  it('a session started with an image writes the file and injects its path into the prompt', async () => {
    // 1x1 png
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const res = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'look at this', image: png }) });
    expect(res.status).toBe(201);
    // uploads dir now holds one image
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(dir, 'state', 'uploads'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toMatch(/\.png$/);
    // don't leak a running session into later tests
    await idle();
  });

  it('rejects a malformed image with 400', async () => {
    const res = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'x', image: 'not-a-data-url' }) });
    expect(res.status).toBe(400);
  });
});

describe('gateway projects', () => {
  it('lists a migrated default project, creates and selects', async () => {
    await idle();
    const list1 = await (await fetch(`${base}/api/projects`, { headers: auth })).json() as { current: string; projects: { id: string; name: string }[] };
    expect(list1.projects.length).toBeGreaterThanOrEqual(1);
    expect(list1.current).toBeTruthy();

    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Beta', cwd: dir }) });
    expect(created.status).toBe(201);
    const beta = await created.json() as { id: string; name: string };
    expect(beta.name).toBe('Beta');

    const sel = await fetch(`${base}/api/projects/current`, { method: 'POST', headers: auth, body: JSON.stringify({ id: beta.id }) });
    expect(sel.status).toBe(200);
    const snap = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { currentProjectId: string };
    expect(snap.currentProjectId).toBe(beta.id);
  });

  it('rejects a project cwd outside the workspace root', async () => {
    const res = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Bad', cwd: '/etc' }) });
    expect(res.status).toBe(400);
  });
});

describe('gateway workspace picker', () => {
  it('lists top-level dirs and nested .git repos, flagging added ones', async () => {
    const { mkdirSync: mk } = await import('node:fs');
    mk(join(dir, 'repo-one'), { recursive: true });
    mk(join(dir, 'repo-two'), { recursive: true });
    // a container with a nested git repo two levels deep
    mk(join(dir, 'container', 'nested-repo', '.git'), { recursive: true });
    const dirs = await (await fetch(`${base}/api/workspace`, { headers: auth })).json() as { name: string; rel: string; path: string; isProject: boolean }[];
    const rels = dirs.map((d) => d.rel);
    expect(rels).toContain('repo-one');
    expect(rels).toContain('repo-two');
    // the nested repo is discovered by its rel path; its name is the leaf
    const nested = dirs.find((d) => d.rel === 'container/nested-repo');
    expect(nested).toBeTruthy();
    expect(nested?.name).toBe('nested-repo');
    // add repo-one as a project, then it should be flagged isProject
    await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'repo-one', cwd: join(dir, 'repo-one') }) });
    const after = await (await fetch(`${base}/api/workspace`, { headers: auth })).json() as { rel: string; isProject: boolean }[];
    expect(after.find((d) => d.rel === 'repo-one')?.isProject).toBe(true);
  });
});

describe('gateway resume existing session', () => {
  it('lists available interactive sessions for a project and resumes one', async () => {
    await idle();
    // stand up a fake interactive tree the app can read (app was built with
    // workspaceRoot=dir; its interactiveProjectsDir defaults to ~/.claude/projects,
    // so we point a dedicated app at a temp interactive dir instead).
    const base2dir = mkdtempSync(join(tmpdir(), 'x056-resume-'));
    const sd = join(base2dir, 'state'); mkdirSync(sd, { recursive: true });
    const cfgA = join(base2dir, 'cfg-a');
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: cfgA }, { name: 'b', configDir: join(base2dir, 'cfg-b') }]);
    const repo = join(base2dir, 'repo'); mkdirSync(repo, { recursive: true });
    const interactive = join(base2dir, 'interactive'); mkdirSync(interactive, { recursive: true });
    const munged = repo.replace(/[/.]/g, '-');
    mkdirSync(join(interactive, munged), { recursive: true });
    writeFileSync(join(interactive, munged, 'sess-xyz.jsonl'), JSON.stringify({ type: 'user', message: { content: 'resume me' } }) + '\n');

    const app2 = await createApp({ token: TOKEN, stateDir: sd, workspaceRoot: base2dir, claudePath: FAKE, interactiveProjectsDir: interactive });
    await app2.listen(0);
    const u = await app2.getUrl();
    try {
      const proj = await (await fetch(`${u}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'repo', cwd: repo }) })).json() as { id: string };
      const avail = await (await fetch(`${u}/api/available-sessions?projectId=${proj.id}`, { headers: auth })).json() as { id: string; firstMessage: string }[];
      expect(avail.map((s) => s.id)).toContain('sess-xyz');
      expect(avail.find((s) => s.id === 'sess-xyz')?.firstMessage).toBe('resume me');
      const r = await fetch(`${u}/api/resume-session`, { method: 'POST', headers: auth, body: JSON.stringify({ projectId: proj.id, sessionId: 'sess-xyz' }) });
      expect(r.status).toBe(200);
      // transcript copied into the failover tree; project now resumes it
      expect(existsSync(join(cfgA, 'projects', munged, 'sess-xyz.jsonl'))).toBe(true);
      const list = await (await fetch(`${u}/api/projects`, { headers: auth })).json() as { projects: { id: string; lastSessionId?: string }[] };
      expect(list.projects.find((p) => p.id === proj.id)?.lastSessionId).toBe('sess-xyz');
    } finally {
      await app2.close();
    }
  });
});
