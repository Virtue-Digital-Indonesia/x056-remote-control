import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionHistory } from '../server/history.js';

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
