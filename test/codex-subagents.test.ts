import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';

/** Lay out rollouts exactly as codex-cli 0.153.4 writes them. */
function codexHome(threads: { id: string; parent?: string; nickname?: string; depth?: number; lines?: unknown[]; done?: string }[]): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const day = join(home, 'sessions', '2026', '09', '07');
  mkdirSync(day, { recursive: true });
  for (const t of threads) {
    const meta = {
      type: 'session_meta', timestamp: '2026-09-07T03:42:55.468Z',
      payload: {
        session_id: t.parent ?? t.id, id: t.id, timestamp: '2026-09-07T03:42:55.468Z', cwd: '/tmp', originator: 'x056',
        // A real session_meta carries the full system prompt: ~14KB on 0.153.4.
        // An 8KB first-line read truncated it, the JSON failed to parse, and the
        // child was silently skipped -- caught only by the live check.
        base_instructions: 'x'.repeat(16 * 1024),
        ...(t.parent ? {
          parent_thread_id: t.parent, thread_source: 'subagent', agent_nickname: t.nickname ?? 'Ampere',
          source: { subagent: { thread_spawn: { parent_thread_id: t.parent, depth: t.depth ?? 1, agent_path: null, agent_nickname: t.nickname ?? 'Ampere', agent_role: null } } },
        } : { source: 'vscode', thread_source: 'user' }),
      },
    };
    const body: unknown[] = [meta, ...(t.lines ?? [])];
    if (t.done !== undefined) {
      body.push({ type: 'event_msg', timestamp: '2026-09-07T03:42:59.900Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 7, total_tokens: 127 } } } });
      body.push({ type: 'event_msg', timestamp: '2026-09-07T03:42:59.976Z', payload: { type: 'task_complete', turn_id: 'tr', last_agent_message: t.done, started_at: 1788752575, completed_at: 1788752579, duration_ms: 4423 } });
    }
    writeFileSync(join(day, `rollout-2026-09-07T03-42-55-${t.id}.jsonl`), body.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return home;
}
const msg = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

const P = '01a079f6-0814-79e2-b4da-020eb5b255eb';
const C1 = '01a079f6-3bec-76c2-9d84-80d6a1b6be7d';
const C2 = '01a079f6-4444-7000-8000-000000000002';
const OTHER = '01a079f6-9999-7000-8000-000000000009';

describe('codex sub-agents on disk', () => {
  const home = codexHome([
    { id: P, lines: [msg('Used spawn_agent')] },
    { id: C1, parent: P, nickname: 'Ampere', lines: [msg('42')], done: '42' },
    { id: C2, parent: P, nickname: 'Bohr', lines: [msg('working...')] },          // no task_complete
    { id: OTHER, lines: [msg('unrelated thread')] },
  ]);

  it('lists exactly the children of a thread, named by nickname, with depth', () => {
    const list = codexAdapter.listSubagents!([home], P);
    expect(list.map((s) => [s.agentId, s.description, s.spawnDepth, s.agentType])).toEqual([
      [C1, 'Ampere', 1, 'codex-subagent'],
      [C2, 'Bohr', 1, 'codex-subagent'],
    ]);
    expect(codexAdapter.listSubagents!([home], OTHER)).toEqual([]);
  });

  it('reads done / result / usage from task_complete and token_count', () => {
    const st = codexAdapter.subagentStatus!([home], P, C1)!;
    expect(st.done).toBe(true);
    expect(st.result).toBe('42');
    expect(st.usage).toEqual({ input: 120, output: 7, cached: 40 });
    expect(st.endedAt).toBe(1788752579000);
  });

  it('a child without task_complete is not done', () => {
    const st = codexAdapter.subagentStatus!([home], P, C2)!;
    expect(st.done).toBe(false);
    expect(st.result).toBeUndefined();
  });

  it('pages a child transcript, and refuses an id that is not this thread\'s child', () => {
    expect(codexAdapter.readSubagentPage!([home], P, C1, 50).rows.map((r) => r.text)).toEqual(['42']);
    // A real thread, but not a child of P: must not be readable through P.
    expect(codexAdapter.readSubagentPage!([home], P, OTHER, 50).rows).toEqual([]);
    expect(codexAdapter.readSubagentPage!([home], P, '../../etc/passwd', 50).rows).toEqual([]);
    expect(codexAdapter.subagentStatus!([home], P, OTHER)).toBeNull();
  });

  it('a grandchild lists under its own parent, not the root', () => {
    const home2 = codexHome([
      { id: P, lines: [] },
      { id: C1, parent: P, nickname: 'Ampere', depth: 1, lines: [] },
      { id: C2, parent: C1, nickname: 'Curie', depth: 2, lines: [] },
    ]);
    expect(codexAdapter.listSubagents!([home2], P).map((s) => s.agentId)).toEqual([C1]);
    expect(codexAdapter.listSubagents!([home2], C1).map((s) => [s.agentId, s.spawnDepth])).toEqual([[C2, 2]]);
  });
});


it('resets inherited completion and later resumed child status', () => {
  const home=codexHome([{id:P},{id:C1,parent:P,lines:[
    {type:'event_msg',payload:{type:'task_complete',last_agent_message:'Old result',completed_at:100}},
    {type:'event_msg',timestamp:'2026-09-07T12:00:00Z',payload:{type:'task_started'}}
  ]}]);
  expect(codexAdapter.subagentStatus!([home],P,C1)).toMatchObject({done:false,status:'running',result:undefined,endedAt:undefined});
});
it('deduplicates accounts sharing a sessions directory', () => {
  const home=codexHome([{id:P},{id:C1,parent:P}]),alias=mkdtempSync(join(tmpdir(),'codex-alias-'));
  symlinkSync(join(home,'sessions'),join(alias,'sessions'));
  expect(codexAdapter.listSubagents!([home,alias,home],P)).toHaveLength(1);
});
it('renders native agent activity live and after reload', () => {
  const item={type:'SubAgentActivity',kind:'started',agent_thread_id:C1,agent_path:'/root/review'};
  expect(codexAdapter.toActivity({type:'item.completed',item})[0]).toMatchObject({toolUseId:C1,status:'start',isSubagent:true});
  const home=codexHome([{id:P,lines:[{type:'event_msg',payload:{type:'item_completed',item}}]}]);
  expect(codexAdapter.readHistoryPage!([home],P,20).rows).toContainEqual(expect.objectContaining({role:'action',sub:true,text:'Agent /root/review: started'}));
});
