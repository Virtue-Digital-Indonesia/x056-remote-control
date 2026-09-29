import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { readFilePage } from '../src/adapters/claude.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { ConversationJournal } from '../server/conversation-journal.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';

describe('advisor rows in the chat history', () => {
  // Claude's advice is encrypted, so the row records THAT it reviewed and how.
  it('reads a Claude advisor result from the transcript as an advisor row', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'x056-advrow-')), 's.jsonl');
    writeFileSync(f, [
      { type: 'user', timestamp: '2026-09-29T10:00:00Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: '2026-09-29T10:00:05Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [
        { type: 'server_tool_use', id: 's1', name: 'advisor', input: {} },
        { type: 'advisor_tool_result', tool_use_id: 's1', content: { type: 'advisor_redacted_result', encrypted_content: 'x' } }] } },
      { type: 'assistant', timestamp: '2026-09-29T10:00:06Z', message: { role: 'assistant', model: 'claude-sonnet-5', content: [
        { type: 'advisor_tool_result', tool_use_id: 's2', content: { type: 'advisor_tool_result_error', error_code: 'overloaded' } }] } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const rows = readFilePage(f, 50).rows.filter((r) => r.role === 'advisor');
    expect(rows.map((r) => r.advisor)).toEqual([{ status: 'reviewed' }, { status: 'unavailable', error: 'overloaded' }]);
  });

  it('journals a ChatGPT consultation and merges it into history by time', () => {
    const state = mkdtempSync(join(tmpdir(), 'x056-advjr-'));
    const j = new ConversationJournal(state);
    j.record('advisor_consult', { projectId: 'p', sessionId: 's', at: '2026-09-29T10:00:03Z', model: 'gpt-6-astra', trigger: 'plan', verdict: 'adjust', advice: 'Check the migration first.', delivered: 'steered', latencyMs: 9000 }, '2026-09-29T10:00:03Z');
    const merged = j.merge('p', 's', [
      { role: 'user', text: 'go', ts: '2026-09-29T10:00:00Z' },
      { role: 'assistant', text: 'done', ts: '2026-09-29T10:00:09Z' },
    ], true);
    expect(merged.map((r) => r.role)).toEqual(['user', 'advisor', 'assistant']);
    expect(merged[1].advisor).toMatchObject({ verdict: 'adjust', advice: 'Check the migration first.', delivered: 'steered' });
  });

  it('emits live advisor_call events for a Claude turn with the advisor on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-advlive-')), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    let n = 0;
    const runSessionFn = (async (o: RunSessionOptions) => {
      if (++n === 2) {
        o.tap?.({ type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'advisor', input: {} }] } } as never);
        o.tap?.({ type: 'assistant', message: { content: [{ type: 'advisor_tool_result', content: { type: 'advisor_redacted_result' } }] } } as never);
      }
      return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult;
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('one', undefined, { model: 'sonnet' }, p.id);
    for (let i = 0; i < 100 && mgr.snapshot().running; i++) await new Promise((r) => setTimeout(r, 10));
    mgr.setDecisionMaker(p.id, sid, 'advisor');
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'two', {});
    for (let i = 0; i < 100 && mgr.snapshot().running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen.filter((e) => e.kind === 'advisor_call').map((e) => [e.data.phase, e.data.model, e.data.status])).toEqual([['start', 'opus', undefined], ['done', 'opus', 'reviewed']]);
  });
});
