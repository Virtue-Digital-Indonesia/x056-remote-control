import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSubagents, readSubagentPage, subagentBrief, subagentDir, subagentFile } from '../src/adapters/subagents.js';

/** A config dir shaped exactly like the CLI's: projects/<dir>/<session>/subagents. */
function fixture(agents: { id: string; meta?: unknown; lines?: string[] }[]) {
  const cfg = mkdtempSync(join(tmpdir(), 'x056-sub-'));
  const sid = 'sess-1';
  const dir = join(cfg, 'projects', '-home-efran-thing', sid, 'subagents');
  mkdirSync(dir, { recursive: true });
  for (const a of agents) {
    writeFileSync(join(dir, `agent-${a.id}.jsonl`), (a.lines ?? []).join('\n') + '\n');
    if (a.meta !== null) writeFileSync(join(dir, `agent-${a.id}.meta.json`), JSON.stringify(a.meta ?? {}));
  }
  return { cfg, sid, dir };
}

const say = (role: string, text: string, ts: string) => JSON.stringify({
  type: role, isSidechain: true, timestamp: ts,
  message: { role, content: [{ type: 'text', text }] },
});

describe('finding a session\'s subagents', () => {
  it('lists them with the type and description the CLI recorded', () => {
    const { cfg, sid } = fixture([
      { id: 'aaa', meta: { agentType: 'Explore', description: 'Mine the codebase', toolUseId: 'toolu_1', spawnDepth: 1 } },
    ]);
    const [s] = listSubagents([cfg], sid);
    expect(s).toMatchObject({ agentId: 'aaa', agentType: 'Explore', description: 'Mine the codebase', toolUseId: 'toolu_1', spawnDepth: 1 });
  });

  it('still lists one whose meta has not been written yet', () => {
    // A subagent that has only just started is exactly the one being watched;
    // dropping the row over a missing label would hide it.
    const { cfg, sid } = fixture([{ id: 'bbb', meta: null, lines: [say('user', 'go', '2026-01-01T00:00:00Z')] }]);
    const [s] = listSubagents([cfg], sid);
    expect(s).toMatchObject({ agentId: 'bbb', agentType: 'agent', description: '' });
    expect(s.bytes).toBeGreaterThan(0);
  });

  it('ignores files that are not agent transcripts', () => {
    const { cfg, sid, dir } = fixture([{ id: 'ccc', meta: {} }]);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(listSubagents([cfg], sid).map((s) => s.agentId)).toEqual(['ccc']);
  });

  it('returns nothing for a session that spawned none, rather than throwing', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'x056-sub-'));
    expect(listSubagents([cfg], 'nope')).toEqual([]);
    expect(subagentDir([cfg], 'nope')).toBeNull();
  });

  it('searches every account, since failover moves where a session was written', () => {
    const empty = mkdtempSync(join(tmpdir(), 'x056-sub-'));
    const { cfg, sid } = fixture([{ id: 'ddd', meta: { agentType: 'Plan' } }]);
    expect(listSubagents([empty, cfg], sid).map((s) => s.agentType)).toEqual(['Plan']);
  });
});

describe('reading one subagent\'s history', () => {
  it('parses its transcript with the same reader the main chat uses', () => {
    const { cfg, sid } = fixture([{
      id: 'aaa', meta: { agentType: 'Explore' },
      lines: [say('user', 'find the bug', '2026-01-01T00:00:00Z'), say('assistant', 'found it', '2026-01-01T00:01:00Z')],
    }]);
    const rows = readSubagentPage([cfg], sid, 'aaa', 50).rows;
    expect(rows.map((r) => [r.role, r.text])).toEqual([['user', 'find the bug'], ['assistant', 'found it']]);
  });

  it('refuses an agentId that is not in the listing', () => {
    // agentId arrives from a query string; building a path out of it directly
    // would let ../ walk out of the session directory.
    const { cfg, sid } = fixture([{ id: 'aaa', meta: {} }]);
    expect(readSubagentPage([cfg], sid, '../../../../etc/passwd', 5).rows).toEqual([]);
    expect(readSubagentPage([cfg], sid, 'unknown', 5).rows).toEqual([]);
  });
});

describe('the brief a subagent was given', () => {
  it('reads the FIRST user entry, not the last — the brief is at the head', () => {
    const { cfg, sid, dir } = fixture([{
      id: 'aaa', meta: {},
      lines: [say('user', 'THE BRIEF', '2026-01-01T00:00:00Z'), say('assistant', 'ok', '2026-01-01T00:00:10Z'), say('user', 'a later turn', '2026-01-01T00:01:00Z')],
    }]);
    expect(subagentBrief(join(dir, 'agent-aaa.jsonl'))).toBe('THE BRIEF');
    expect(subagentFile([cfg], sid, 'aaa')).toBe(join(dir, 'agent-aaa.jsonl'));
  });

  it('returns empty for a file that does not exist, rather than throwing', () => {
    expect(subagentBrief('/nope/missing.jsonl')).toBe('');
  });

  it('refuses to resolve an agentId that is not in the listing', () => {
    const { cfg, sid } = fixture([{ id: 'aaa', meta: {} }]);
    expect(subagentFile([cfg], sid, '../../escape')).toBeNull();
  });
});
