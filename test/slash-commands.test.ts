import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';

/**
 * Shapes copied from real transcripts on this box, not invented: a slash command is a `user` turn wrapping <command-name>, and a
 * compaction is a `system` entry with subtype compact_boundary followed by a
 * `user` turn flagged isCompactSummary.
 */
function transcript(lines: unknown[]): { configDir: string; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'x056-slash-'));
  const projects = join(dir, 'projects', '-tmp-work');
  mkdirSync(projects, { recursive: true });
  const sessionId = 'sess-1';
  writeFileSync(join(projects, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { configDir: dir, sessionId };
}

const read = (lines: unknown[]) => {
  const { configDir, sessionId } = transcript(lines);
  return claudeAdapter.readHistory!([configDir], sessionId, 100);
};

const userText = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', timestamp: '2026-08-24T09:00:00Z', message: { role: 'user', content: text }, ...extra });
const assistantText = (text: string) =>
  ({ type: 'assistant', timestamp: '2026-08-24T09:01:00Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } });

const CMD = `<command-name>/recap</command-name>
            <command-message>recap</command-message>
            <command-args></command-args>`;

describe('slash commands in the transcript', () => {
  it('surfaces the command instead of dropping it — a summary with no visible request is what this fixes', () => {
    const rows = read([userText(CMD), assistantText('Here is the recap.')]);
    const cmd = rows.find((r) => r.role === 'command');
    expect(cmd?.text).toBe('/recap');
    // and it did not sneak through as a user message full of XML
    expect(rows.some((r) => r.role === 'user' && r.text.includes('<command-name>'))).toBe(false);
  });

  it('keeps the arguments, since "/loop 5m" and "/loop" are different acts', () => {
    const withArgs = CMD.replace('/recap', '/loop').replace('<command-args></command-args>', '<command-args>5m /check</command-args>');
    const rows = read([userText(withArgs)]);
    const cmd = rows.find((r) => r.role === 'command');
    expect(cmd?.text).toBe('/loop');
    expect(cmd?.args).toBe('5m /check');
  });

  it('still drops the other system-injected user turns', () => {
    const rows = read([
      userText('<system-reminder>noise</system-reminder>'),
      userText('<task-notification>done</task-notification>'),
      userText('Caveat: something'),
      userText('a real message'),
    ]);
    expect(rows.filter((r) => r.role === 'user').map((r) => r.text)).toEqual(['a real message']);
    expect(rows.some((r) => r.role === 'command')).toBe(false);
  });
});

describe('slash command OUTPUT', () => {
  // Regression for the real failure: a command's answer is NOT an assistant
  // message. Claude Code files it as {type:"system", subtype:"local_command"}
  // with the text wrapped in <local-command-stdout>. Skipping every system
  // entry meant /recap kept its chip on reload and lost its answer.
  const stdout = (text: string) => ({
    type: 'system', subtype: 'local_command', level: 'info',
    timestamp: '2026-08-25T04:35:33Z',
    content: `<local-command-stdout>${text}</local-command-stdout>`,
  });

  it('renders the command output that follows the command', () => {
    const rows = read([userText(CMD), stdout('Building the hotel PMS: M6 is done.')]);
    expect(rows.map((r) => r.role)).toEqual(['command', 'assistant']);
    expect(rows[1].text).toBe('Building the hotel PMS: M6 is done.');
  });

  it('strips the wrapper rather than showing raw XML', () => {
    const rows = read([stdout('plain text')]);
    expect(rows[0].text).not.toContain('local-command-stdout');
  });

  it('handles stderr the same way', () => {
    const rows = read([{
      type: 'system', subtype: 'local_command', level: 'info',
      content: '<local-command-stderr>it failed</local-command-stderr>',
    }]);
    expect(rows[0]?.text).toBe('it failed');
  });

  it('drops an empty output instead of leaving a blank bubble', () => {
    expect(read([stdout('   ')])).toEqual([]);
  });

  it('leaves other system subtypes alone', () => {
    const rows = read([{ type: 'system', subtype: 'something_else', content: 'noise' }]);
    expect(rows).toEqual([]);
  });
});

describe('compaction in the transcript', () => {
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: '2026-08-24T09:02:00Z',
    compactMetadata: { trigger: 'auto', preTokens: 999666 },
  };

  it('marks where the context was compacted, so a gap in history has a reason', () => {
    const rows = read([assistantText('before'), boundary, assistantText('after')]);
    const notice = rows.find((r) => r.role === 'notice');
    expect(notice?.text).toContain('context compacted');
    expect(notice?.text).toContain('automatically');
    expect(notice?.text).toContain('1000k tokens');
  });

  it('says nothing about the trigger when it was manual', () => {
    const manual = { ...boundary, compactMetadata: { trigger: 'manual', preTokens: 5000 } };
    const rows = read([manual]);
    expect(rows.find((r) => r.role === 'notice')?.text).toBe('context compacted · 5k tokens');
  });

  it('labels the recap as a summary rather than letting it pose as the user talking', () => {
    const rows = read([userText('This session is being continued…', { isCompactSummary: true })]);
    expect(rows.find((r) => r.role === 'summary')?.text).toContain('This session is being continued');
    expect(rows.some((r) => r.role === 'user')).toBe(false);
  });
});

describe('panel rendering', () => {
  const html = readFileSync('server/public/panel.html', 'utf8');

  it('has a renderer for each new row type', () => {
    for (const fn of ['function nodeCmd', 'function nodeNotice', 'function nodeSummary']) {
      expect(html).toContain(fn);
    }
  });

  it('explains what the common commands do, rather than showing a bare name', () => {
    expect(html).toContain("'/clear': 'cleared the conversation");
    expect(html).toContain("'/compact': 'compacted the context");
  });

  it('collapses the summary by default — it is usually thousands of words', () => {
    expect(html).toContain("document.createElement('details')");
    expect(html).toContain('tap to expand');
  });
});
