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
  it('extracts user prompts, assistant text, tool calls and slash commands, skipping thinking/synthetic/meta noise', () => {
    const sid = 'sess-1';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'first question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'first answer' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } },
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
      // the tool call is surfaced as an action row so the trail of what the
      // agent DID survives a reload, not just what it said
      { role: 'action', text: 'Running: ls -la', sub: false },
      // a slash command is surfaced too: dropping it left the transcript
      // claiming the user said nothing before whatever the command produced
      { role: 'command', text: '/model', args: undefined },
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

describe('tool-call history survives a reload', () => {
  it('replays claude tool calls as action rows, interleaved with the messages', () => {
    const sid = 'sess-act';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'fix the build' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b/App.tsx' } },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
        { type: 'text', text: 'running the tests' },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't3', name: 'Task', input: { description: 'audit the config' } },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all green' }] } },
    ]);
    const rows = readSessionHistory([dir], sid);
    expect(rows.map((r) => `${r.role}:${r.text}`)).toEqual([
      'user:fix the build',
      'action:Reading App.tsx',
      'action:Running: npm test',
      'assistant:running the tests',
      'action:Subagent: audit the config',
      'assistant:all green',
    ]);
    expect(rows.find((r) => r.text.startsWith('Subagent'))?.sub).toBe(true);
    expect(rows.find((r) => r.text === 'Running: npm test')?.sub).toBe(false);
  });
});

describe('a prompt steered into a running turn', () => {
  // The CLI does not record it as a `user` entry -- it files it under
  // `attachment.type === 'queued_command'` (verified against CLI 2.1.258).
  // Dropping it left the model answering a question that was nowhere on screen.
  it('renders as a user message in the right place', () => {
    const sid = 'sess-inject';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'run the long thing' } },
      {
        type: 'attachment',
        timestamp: '2026-09-02T14:41:56.474Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: [{ type: 'text', text: 'also, what is 17 times 23?' }],
        },
      },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '17x23 = 391' }] } },
    ]);

    const rows = readSessionHistory([dir], sid);
    expect(rows.map((r) => r.role)).toEqual(['user', 'user', 'assistant']);
    expect(rows[1].text).toBe('also, what is 17 times 23?');
  });

  it('ignores attachments that are not steered prompts', () => {
    const sid = 'sess-att';
    const dir = configDirWithTranscript(sid, [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'attachment', attachment: { type: 'selected_lines_in_ide', content: 'noise' } },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: '   ' }] } },
    ]);

    expect(readSessionHistory([dir], sid).map((r) => r.role)).toEqual(['user']);
  });
})
