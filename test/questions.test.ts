import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
let auth: Record<string, string>;

/** A turn that ends by asking the user something (the ASK convention). */
const ASKING = 'Here is my plan.\n\n<<<ASK\nquestion: Proceed with the migration?\noptions: Yes | No\n>>>';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'x056-q-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg-a') }]);

  const scenario = join(dir, 'ask.jsonl');
  writeFileSync(scenario, [
    JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'q' } }),
    JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: ASKING }] } } }),
    JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: ASKING } }),
    JSON.stringify({ exit: 0 }),
  ].join('\n'));
  // The continuation (answering the question) does NOT ask again, so the
  // question must be gone afterwards — a deterministic check of the supersede.
  const resume = join(dir, 'resume.jsonl');
  writeFileSync(resume, [
    JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'q' } }),
    JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } } }),
    JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'Done.' } }),
    JSON.stringify({ exit: 0 }),
  ].join('\n'));
  process.env.X056_FAKE_SCENARIO = scenario;
  process.env.X056_FAKE_SCENARIO_RESUME = resume;

  auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  app = await createApp({ token: TOKEN, stateDir, workspaceRoot: dir, claudePath: FAKE });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  delete process.env.X056_FAKE_SCENARIO;
  delete process.env.X056_FAKE_SCENARIO_RESUME;
  await app?.close();
});

type Q = { projectId: string; sessionId: string; question: string; options: string[] };
async function questions(): Promise<Q[]> {
  return (await fetch(`${base}/api/questions`, { headers: auth })).json() as Promise<Q[]>;
}
/** Poll until the turn finishes and its question (if any) is recorded. */
async function waitForQuestion(sessionId: string, timeoutMs = 15000): Promise<Q | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await questions()).find((q) => q.sessionId === sessionId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 150));
  }
  return undefined;
}
async function turnIdle(sessionId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await (await fetch(`${base}/api/projects`, { headers: auth })).json() as { projects: { runningSessionIds?: string[] }[] };
    if (!p.projects.some((x) => (x.runningSessionIds ?? []).includes(sessionId))) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('pending questions survive a reload (server-side, not just in the browser)', () => {
  it('records an unanswered question and serves it from GET /api/questions', async () => {
    const started = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'do the thing' }) })).json() as { sessionId: string };
    const q = await waitForQuestion(started.sessionId);
    expect(q).toBeTruthy();
    expect(q!.question).toBe('Proceed with the migration?');
    expect(q!.options).toEqual(['Yes', 'No']);
    expect(q!.projectId).toBeTruthy(); // addressable, so the panel can render it on the right conversation
  }, 30000);

  it('survives a gateway RESTART (the container swap every deploy performs)', async () => {
    const before = await questions();
    expect(before.length).toBeGreaterThan(0);
    // A fresh app over the SAME state dir = what a swap/crash-restart looks like.
    const app2 = await createApp({ token: TOKEN, stateDir: join(dir, 'state'), workspaceRoot: dir, claudePath: FAKE });
    await app2.listen(0);
    try {
      const after = await (await fetch(`${await app2.getUrl()}/api/questions`, { headers: auth })).json() as Q[];
      expect(after.map((q) => q.sessionId).sort()).toEqual(before.map((q) => q.sessionId).sort());
      expect(after[0].question).toBe('Proceed with the migration?');
      expect(after[0].options).toEqual(['Yes', 'No']);
    } finally {
      await app2.close();
    }
  }, 30000);

  it('answering it (a new turn for that conversation) clears the question', async () => {
    const list = await questions();
    const sid = list[0]!.sessionId;
    await turnIdle(sid);
    // Answering the question = sending the next message into the same conversation.
    const res = await fetch(`${base}/api/sessions/current/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'Yes' }) });
    expect(res.ok).toBe(true);
    // Cleared the moment the new turn launches — no stale card left behind.
    expect((await questions()).some((q) => q.sessionId === sid)).toBe(false);
    // The continuation doesn't ask, so it stays cleared once the turn finishes.
    await turnIdle(sid);
    expect((await questions()).some((q) => q.sessionId === sid)).toBe(false);
  }, 30000);
});
