import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = new URL('./bin/fake-claude', import.meta.url).pathname;

describe('fake-claude', () => {
  it('replays a scenario file as NDJSON and exits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-fake-'));
    const scenario = join(dir, 's.jsonl');
    writeFileSync(
      scenario,
      [
        JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 's1' } }),
        JSON.stringify({ delayMs: 10 }),
        JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, result: 'ok' } }),
        JSON.stringify({ exit: 0 }),
      ].join('\n'),
    );
    const out = execFileSync(BIN, ['-p', '--session-id', 's1', 'task'], {
      env: { ...process.env, X056_FAKE_SCENARIO: scenario },
      encoding: 'utf8',
    });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['system', 'result']);
  });

  it('uses the resume scenario when --resume is in argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-fake-'));
    const resumeScenario = join(dir, 'resume.jsonl');
    writeFileSync(
      resumeScenario,
      [
        JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, result: 'resumed' } }),
        JSON.stringify({ exit: 0 }),
      ].join('\n'),
    );
    const out = execFileSync(BIN, ['-p', '--resume', 's1', 'continue'], {
      env: { ...process.env, X056_FAKE_SCENARIO: '/nonexistent', X056_FAKE_SCENARIO_RESUME: resumeScenario },
      encoding: 'utf8',
    });
    expect(JSON.parse(out.trim()).result).toBe('resumed');
  });
});
