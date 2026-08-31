import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedBrief, listSubagents, readSubagentPage, subagentBrief, subagentDir, subagentFile, subagentFiles, transcriptIndex } from '../src/adapters/subagents.js';

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

describe('a subagent abandoned by an earlier turn', () => {
  // Status is "no tool_result AND the turn is live" — but a subagent the
  // PREVIOUS turn abandoned also has no result, so that alone reports it as
  // running forever. The endpoint additionally requires the transcript to have
  // been written to recently; this pins the input that decision reads.
  it('exposes updatedAt, so staleness can be told from silence', () => {
    const { cfg, sid, dir } = fixture([{ id: 'aaa', meta: {}, lines: [say('user', 'go', '2026-01-01T00:00:00Z')] }]);
    const [s] = listSubagents([cfg], sid);
    expect(typeof s.updatedAt).toBe('number');
    expect(Date.now() - s.updatedAt!).toBeLessThan(60_000); // just written

    // Backdate the transcript the way an hours-old abandoned one would be.
    const old = Date.now() - 6 * 3600 * 1000;
    utimesSync(join(dir, 'agent-aaa.jsonl'), old / 1000, old / 1000);
    const [stale] = listSubagents([cfg], sid);
    expect(Date.now() - stale.updatedAt!).toBeGreaterThan(3600_000);
  });
});

describe('resolving every path at once', () => {
  // subagentFile() re-lists the directory per call. For one lookup that is
  // fine; for a whole session it is quadratic — 90 subagents cost 536ms of a
  // 540ms request, against 2ms of actual scanning.
  it('returns a path per subagent from a single listing', () => {
    const { cfg, sid, dir } = fixture([{ id: 'aaa', meta: {} }, { id: 'bbb', meta: {} }]);
    const files = subagentFiles([cfg], sid);
    expect([...files.keys()].sort()).toEqual(['aaa', 'bbb']);
    expect(files.get('aaa')).toBe(join(dir, 'agent-aaa.jsonl'));
  });

  it('accepts an already-computed list rather than walking again', () => {
    const { cfg, sid } = fixture([{ id: 'aaa', meta: {} }]);
    const list = listSubagents([cfg], sid);
    expect(subagentFiles([cfg], sid, list).get('aaa')).toBe(subagentFiles([cfg], sid).get('aaa'));
  });

  it('is empty for a session with no subagents, not an error', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'x056-sub-'));
    expect(subagentFiles([cfg], 'nope').size).toBe(0);
  });

  it('caches a brief, since it is the first entry and never changes', () => {
    const { cfg, sid, dir } = fixture([{ id: 'aaa', meta: {}, lines: [say('user', 'THE BRIEF', '2026-01-01T00:00:00Z')] }]);
    const f = join(dir, 'agent-aaa.jsonl');
    expect(cachedBrief(f)).toBe('THE BRIEF');
    // Rewriting the file does not change what a cached brief reports — correct,
    // because the first entry of a transcript is immutable in practice.
    expect(cachedBrief(f)).toBe('THE BRIEF');
    expect(subagentFiles([cfg], sid).get('aaa')).toBe(f);
  });
});

describe('indexing transcripts', () => {
  // findTranscript() lists projects/ RECURSIVELY, which descends into every
  // session's subagents/ directory. Calling it once per conversation cost 3.5s
  // to enumerate 52 of them, before a byte was scanned.
  function withTranscripts(entries: { project: string; sessionId: string }[]) {
    const cfg = mkdtempSync(join(tmpdir(), 'x056-idx-'));
    for (const e of entries) {
      const d = join(cfg, 'projects', e.project);
      mkdirSync(join(d, e.sessionId, 'subagents'), { recursive: true });
      writeFileSync(join(d, `${e.sessionId}.jsonl`), '{}\n');
      // A decoy one level deeper: the index must not pick it up as a session.
      writeFileSync(join(d, e.sessionId, 'subagents', 'agent-zzz.jsonl'), '{}\n');
    }
    return cfg;
  }

  it('maps every sessionId to its transcript in one walk', () => {
    const cfg = withTranscripts([{ project: '-a', sessionId: 's1' }, { project: '-b', sessionId: 's2' }]);
    const idx = transcriptIndex([cfg]);
    expect([...idx.keys()].sort()).toEqual(['s1', 's2']);
    expect(idx.get('s1')).toBe(join(cfg, 'projects', '-a', 's1.jsonl'));
  });

  it('does not mistake a subagent transcript for a session', () => {
    const cfg = withTranscripts([{ project: '-a', sessionId: 's1' }]);
    expect([...transcriptIndex([cfg]).keys()]).toEqual(['s1']);
  });

  it('lets the first account win, matching findTranscript', () => {
    const a = withTranscripts([{ project: '-a', sessionId: 'dup' }]);
    const b = withTranscripts([{ project: '-b', sessionId: 'dup' }]);
    expect(transcriptIndex([a, b]).get('dup')).toBe(join(a, 'projects', '-a', 'dup.jsonl'));
  });

  it('skips an account with no projects tree instead of throwing', () => {
    expect(transcriptIndex([mkdtempSync(join(tmpdir(), 'x056-idx-'))]).size).toBe(0);
  });
});
