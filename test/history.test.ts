import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionHistory } from '../server/history.js';
import { readHistoryPage } from '../src/adapters/claude.js';

function configDirWithTranscript(sessionId: string, lines: unknown[]): string {
  const configDir = mkdtempSync(join(tmpdir(), 'x056-hist-'));
  const projectDir = join(configDir, 'projects', '-some-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return configDir;
}

describe('readSessionHistory', () => {
  it('extracts user prompts and assistant text, skipping tool/thinking/synthetic/meta noise', () => {
    const sid = 'sess-1';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'first question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'first answer' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
      { type: 'assistant', model: '<synthetic>', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] }, isApiErrorMessage: true },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } },
      { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' } },
      { type: 'user', message: { role: 'user', content: '<system-reminder>background</system-reminder>' } },
      { type: 'user', message: { role: 'user', content: 'second question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
    ]);

    const rows = readSessionHistory([dir], sid);
    expect(rows).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: 'second answer' },
    ]);
  });

  it('emits a model marker on the first main-turn model and on each change, ignoring subagents', () => {
    const sid = 'sess-model';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'on fable' }] } },
      // subagent (sidechain) on a different model — must NOT produce a marker
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'sub' }] } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'still fable' }] } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'now sonnet' }] } },
    ]);
    const rows = readSessionHistory([dir], sid);
    expect(rows).toEqual([
      { role: 'user', text: 'go' },
      { role: 'model', text: 'claude-fable-5' },
      { role: 'assistant', text: 'on fable' },
      { role: 'assistant', text: 'sub' },        // subagent text still shown, but no marker for it
      { role: 'assistant', text: 'still fable' },
      { role: 'model', text: 'claude-sonnet-5' }, // switch fable -> sonnet
      { role: 'assistant', text: 'now sonnet' },
    ]);
  });

  it('extracts the transcript timestamp so the panel can interleave with live activity', () => {
    const sid = 'sess-ts';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', timestamp: '2026-07-06T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no timestamp on this one' }] } },
    ]);
    const rows = readSessionHistory([dir], sid);
    expect(rows).toEqual([
      { role: 'user', text: 'hi', ts: '2026-07-06T10:00:00.000Z' },
      { role: 'assistant', text: 'no timestamp on this one' },
    ]);
  });

  it('strips the raw <<<ASK>>> block from assistant text, and drops an assistant turn that was only an ASK', () => {
    const sid = 'sess-ask';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'do the thing' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is my plan.\n\n<<<ASK\nquestion: Proceed?\noptions: Yes | No\n>>>' }] } },
      { type: 'user', message: { role: 'user', content: 'Yes' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<<<ASK\nquestion: Only a question?\n>>>' }] } },
    ]);
    const rows = readSessionHistory([dir], sid);
    expect(rows).toEqual([
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'Here is my plan.' },
      { role: 'user', text: 'Yes' },
      // the ask-only assistant turn is dropped (nothing left after stripping)
    ]);
  });

  it('returns [] when the session transcript is not found in any config dir', () => {
    const dir = configDirWithTranscript('other', [{ type: 'user', message: { role: 'user', content: 'x' } }]);
    expect(readSessionHistory([dir], 'missing')).toEqual([]);
  });

  it('honors the limit by returning the last N entries', () => {
    const sid = 'sess-2';
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push({ type: 'user', message: { role: 'user', content: `msg ${i}` } });
    const dir = configDirWithTranscript(sid, lines);
    const rows = readSessionHistory([dir], sid, 3);
    expect(rows.map((r) => r.text)).toEqual(['msg 7', 'msg 8', 'msg 9']);
  });
});

describe('readSessionHistory on a very large transcript', () => {
  // Real transcripts reach hundreds of MB (every base64 screenshot is stored
  // inline). Reading the whole file cost seconds per request and, past V8's
  // ~512MB max string length, threw outright — which surfaced as a live
  // conversation rendering zero messages. Only the tail is ever needed.
  it('reads the recent messages from a huge file without loading it all', () => {
    const sid = 'sess-huge';
    const configDir = mkdtempSync(join(tmpdir(), 'x056-hist-big-'));
    const projectDir = join(configDir, 'projects', '-some-project');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sid}.jsonl`);
    // ~40MB of bulky tool results (stand-ins for base64 screenshots), then the
    // real messages at the end.
    const blob = 'x'.repeat(400_000);
    const bulk: string[] = [];
    for (let i = 0; i < 100; i++) {
      bulk.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: blob }] } }));
    }
    bulk.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'the real question' } }));
    bulk.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the real answer' }] } }));
    writeFileSync(file, bulk.join('\n') + '\n');

    const rows = readSessionHistory([configDir], sid, 10);
    const texts = rows.filter((r) => r.role !== 'model').map((r) => r.text);
    expect(texts).toContain('the real question');
    expect(texts).toContain('the real answer');
  });

  it('does not emit a mangled entry from the line the tail window cuts in half', () => {
    const sid = 'sess-cut';
    const configDir = mkdtempSync(join(tmpdir(), 'x056-hist-cut-'));
    const projectDir = join(configDir, 'projects', '-some-project');
    mkdirSync(projectDir, { recursive: true });
    // One line far larger than the initial 2MB window, so the window lands
    // mid-line; the partial must be discarded, not parsed into garbage.
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(3_000_000) }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'tail question' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'tail answer' }] } }),
    ];
    writeFileSync(join(projectDir, `${sid}.jsonl`), lines.join('\n') + '\n');
    // limit 2 is satisfied by the first (2MB) window, so it never widens — the
    // half-line at the window's start must be dropped, not parsed into garbage.
    const rows = readSessionHistory([configDir], sid, 2).filter((r) => r.role !== 'model');
    expect(rows.map((r) => r.text)).toEqual(['tail question', 'tail answer']);
  });
});

describe('paginated history (scroll-back)', () => {
  function bigTranscript(n: number): { configDir: string; sid: string } {
    const sid = 'sess-page';
    const configDir = mkdtempSync(join(tmpdir(), 'x056-hist-page-'));
    const projectDir = join(configDir, 'projects', '-some-project');
    mkdirSync(projectDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `q${i}` } }));
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } }));
    }
    writeFileSync(join(projectDir, `${sid}.jsonl`), lines.join('\n') + '\n');
    return { configDir, sid };
  }

  it('walks the whole conversation backwards, page by page, without gaps or repeats', () => {
    const { configDir, sid } = bigTranscript(50); // 100 rows
    const seen: string[] = [];
    let before: number | undefined;
    let done = false;
    let guard = 0;
    while (!done && guard++ < 50) {
      const page = readHistoryPage([configDir], sid, 15, before);
      // newest-first pages, each internally in chronological order
      seen.unshift(...page.rows.map((r) => r.text));
      before = page.cursor;
      done = page.done;
    }
    expect(done).toBe(true);
    const expected: string[] = [];
    for (let i = 0; i < 50; i++) { expected.push(`q${i}`); expected.push(`a${i}`); }
    expect(seen).toEqual(expected); // every row, in order, exactly once
  });

  it('reports done on a conversation that fits in one page', () => {
    const { configDir, sid } = bigTranscript(2); // 4 rows
    const page = readHistoryPage([configDir], sid, 50);
    expect(page.rows.map((r) => r.text)).toEqual(['q0', 'a0', 'q1', 'a1']);
    expect(page.done).toBe(true);
  });

  it('is not done when older rows remain, and the next page is contiguous with no overlap', () => {
    const { configDir, sid } = bigTranscript(10); // rows q0,a0 … q9,a9
    const first = readHistoryPage([configDir], sid, 5);
    expect(first.done).toBe(false);
    // Newest page: the last 5 rows, chronological within the page.
    expect(first.rows.map((r) => r.text)).toEqual(['a7', 'q8', 'a8', 'q9', 'a9']);
    // The page before it: contiguous, ending immediately before 'a7'.
    const second = readHistoryPage([configDir], sid, 5, first.cursor);
    expect(second.rows.map((r) => r.text)).toEqual(['q5', 'a5', 'q6', 'a6', 'q7']);
  });

  it('returns an empty done page for an unknown session instead of throwing', () => {
    const { configDir } = bigTranscript(1);
    expect(readHistoryPage([configDir], 'nope', 10)).toEqual({ rows: [], cursor: 0, done: true });
  });
});
