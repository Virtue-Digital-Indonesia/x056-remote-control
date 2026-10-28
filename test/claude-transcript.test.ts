import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { claudeFailureText, readHistory } from '../src/adapters/claude.js';
import { buildRecap, claudeProjectDirName, resolveClaudeTranscript, sessionResetText, stripRecoveredContext, withRecoveredContext } from '../src/claude-transcript.js';
import { withMemoryContext } from '../src/memory-context.js';
import { withMessageSender } from '../src/message-sender.js';
import { cleanMemorySource } from '../server/memory-sources.js';
import { ConversationJournal } from '../server/conversation-journal.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';

const FAKE = new URL('./bin/fake-claude', import.meta.url).pathname;
const SID = '11111111-2222-4333-8444-555555555555';

function tree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'x056-tr-')));
  const cwd = join(dir, 'work', 'my_project');
  mkdirSync(cwd, { recursive: true });
  const shared = join(dir, 'shared-projects');
  mkdirSync(shared, { recursive: true });
  // Two accounts whose projects/ both link to ONE shared tree, as in production.
  const configDirs = ['a', 'b'].map((n) => { const c = join(dir, 'cfg-' + n); mkdirSync(c); symlinkSync(shared, join(c, 'projects')); return c; });
  return { dir, cwd, shared, configDirs, expected: join(shared, claudeProjectDirName(cwd), SID + '.jsonl') };
}

describe('resolveClaudeTranscript', () => {
  it('encodes the project dir the way the CLI does', () => {
    expect(claudeProjectDirName('/home/efran/remote-development/obscura')).toBe('-home-efran-remote-development-obscura');
    expect(claudeProjectDirName('/a/b_c.d')).toBe('-a-b-c-d');
  });

  it('present at the expected path -> resume unchanged', () => {
    const t = tree();
    mkdirSync(join(t.shared, claudeProjectDirName(t.cwd)));
    writeFileSync(t.expected, '{}\n');
    const v = resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: SID });
    expect(v.decision).toBe('present');
  });

  it('under another project dir -> symlinked into the expected one (with its subagents dir), then resume', () => {
    const t = tree();
    const other = join(t.shared, '-old-place');
    mkdirSync(join(other, SID, 'subagents'), { recursive: true });
    writeFileSync(join(other, SID + '.jsonl'), '{"type":"user"}\n');
    const dry = resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: SID, dryRun: true });
    expect(dry).toMatchObject({ decision: 'relinked', dryRun: true });
    expect(existsSync(t.expected)).toBe(false); // a dry run writes nothing
    const v = resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: SID });
    expect(v).toMatchObject({ decision: 'relinked', from: join(other, SID + '.jsonl') });
    // Both accounts share the tree: linked once.
    expect((v as { to: string[] }).to).toHaveLength(1);
    expect(lstatSync(t.expected).isSymbolicLink()).toBe(true);
    expect(readlinkSync(t.expected)).toBe(join(other, SID + '.jsonl'));
    expect(readlinkSync(join(t.shared, claudeProjectDirName(t.cwd), SID))).toBe(join(other, SID));
    // Through every account's projects/ link the CLI now finds it.
    for (const c of t.configDirs) expect(readFileSync(join(c, 'projects', claudeProjectDirName(t.cwd), SID + '.jsonl'), 'utf8')).toContain('user');
    expect(resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: SID }).decision).toBe('present');
  });

  it('replaces a dangling link at the expected path', () => {
    const t = tree();
    mkdirSync(join(t.shared, claudeProjectDirName(t.cwd)));
    symlinkSync(join(t.dir, 'nowhere.jsonl'), t.expected);
    mkdirSync(join(t.shared, '-elsewhere'));
    writeFileSync(join(t.shared, '-elsewhere', SID + '.jsonl'), '{}\n');
    expect(resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: SID }).decision).toBe('relinked');
    expect(readlinkSync(t.expected)).toBe(join(t.shared, '-elsewhere', SID + '.jsonl'));
  });

  it('nowhere -> missing', () => {
    const t = tree();
    mkdirSync(join(t.shared, '-other'));
    writeFileSync(join(t.shared, '-other', 'another-session-0000.jsonl'), '{}\n');
    expect(resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: SID }).decision).toBe('missing');
  });

  it('fails open: no projects tree at all, or an odd id, is unknown (resume as before)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-tr-'));
    expect(resolveClaudeTranscript({ configDirs: [join(dir, 'cfg')], cwd: dir, sessionId: SID }).decision).toBe('unknown');
    const t = tree();
    expect(resolveClaudeTranscript({ configDirs: t.configDirs, cwd: t.cwd, sessionId: '../../etc' }).decision).toBe('unknown');
  });
});

describe('recap', () => {
  it('is bounded: last 20 user/assistant messages, 600 chars each, 12k in all', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i} ` + 'x'.repeat(2000), ts: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }));
    rows.push({ role: 'error', text: 'exit code 0', ts: '2026-10-28T07:22:55.202Z' }, { role: 'advisor', text: 'model unchanged', ts: '2026-10-28T07:22:55.202Z' });
    const r = buildRecap(rows);
    // 20 picked, each cut to 600; the 12k total then drops the oldest two.
    expect(r.count).toBe(18);
    expect(r.text.length).toBeLessThanOrEqual(12_000);
    expect(r.text).not.toContain('m21 ');
    expect(r.text).toContain('m22 ');
    expect(buildRecap(rows.slice(30)).count).toBe(10);
    expect(r.text.split('\n').every((l) => l.length < 700)).toBe(true);
    expect(r.text).not.toContain('exit code 0');
    const tight = buildRecap(rows, { messages: 20, perMessage: 600, total: 1500 });
    expect(tight.text.length).toBeLessThanOrEqual(1500);
    expect(tight.text).toContain('m39 '); // newest kept, oldest dropped
    expect(buildRecap([])).toEqual({ text: '', count: 0 });
  });

  it('is stripped wherever a prompt is read back', () => {
    const recap = buildRecap([{ role: 'user', text: 'earlier ask', ts: '2026-09-03T10:00:00Z' }]).text;
    const sent = withRecoveredContext(withMessageSender(withMemoryContext('the new message', 'some memory'), { kind: 'conversation', messageId: 'm1' }), recap);
    expect(sent.startsWith('[Recovered context:')).toBe(true);
    expect(sent).toContain('User (2026-09-03 10:00 UTC): earlier ask');
    expect(stripRecoveredContext(sent).startsWith('[Shared memory reference]')).toBe(true);
    expect(cleanMemorySource(sent)).toBe('the new message');
    // A slash command reaches the CLI untouched.
    expect(withRecoveredContext('/compact', recap)).toBe('/compact');
    // The transcript row the CLI writes reads back as the message alone.
    const t = tree();
    const proj = join(t.shared, claudeProjectDirName(t.cwd));
    mkdirSync(proj);
    writeFileSync(t.expected, JSON.stringify({ type: 'user', timestamp: '2026-10-29T00:00:00Z', message: { role: 'user', content: withRecoveredContext('the new message', recap) } }) + '\n');
    const rows = readHistory(t.configDirs, SID);
    expect(rows.map((r) => r.text)).toEqual(['the new message']);
  });

  it('says how many messages it carried', () => {
    expect(sessionResetText(3)).toBe('No saved transcript for this conversation, so it continued in a fresh session with a recap of the last 3 messages.');
    expect(sessionResetText(0)).toContain('fresh session');
  });
});

describe('claudeFailureText', () => {
  it('reads errors[] from an error_during_execution result (no `result` string)', () => {
    const e = { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: [`No conversation found with session ID: ${SID}`] };
    expect(claudeFailureText(e)).toBe(`No conversation found with session ID: ${SID}`);
    expect(claudeFailureText({ type: 'result', is_error: true, result: 'API Error' })).toBe('API Error');
    expect(claudeFailureText({ type: 'result', is_error: false, result: 'ok' })).toBeUndefined();
  });
});

// ---- through the manager, with the fake CLI ----

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ['X056_FAKE_SCENARIO', 'X056_FAKE_SCENARIO_RESUME', 'X056_FAKE_ARGV_LOG', 'X056_PERSISTENT']) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

function managerFixture(opts: { projectsTree: boolean; persistent: boolean; resumeScenario?: unknown[] }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'x056-trm-')));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const cfg = join(dir, 'cfg-a');
  mkdirSync(cfg, { recursive: true });
  if (opts.projectsTree) mkdirSync(join(cfg, 'projects'));
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Alpha', emailAddress: 'alpha@example.com' } }));
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: cfg }]);
  const ok = join(dir, 'new.jsonl');
  writeFileSync(ok, [
    { event: { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh reply' }] } } },
    { event: { type: 'result', subtype: 'success', is_error: false, result: 'fresh reply' } },
    { exit: 0 },
  ].map((l) => JSON.stringify(l)).join('\n'));
  // What the real CLI does on --resume of a session with no transcript.
  const missing = join(dir, 'resume.jsonl');
  writeFileSync(missing, (opts.resumeScenario ?? [
    { stderr: 'No conversation found with session ID: X' },
    { event: { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: ['No conversation found with session ID: X'] } },
    { exit: 1 },
  ]).map((l) => JSON.stringify(l)).join('\n'));
  process.env.X056_FAKE_SCENARIO = ok;
  process.env.X056_FAKE_SCENARIO_RESUME = missing;
  process.env.X056_FAKE_ARGV_LOG = join(dir, 'argv.log');
  if (opts.persistent) delete process.env.X056_PERSISTENT; else process.env.X056_PERSISTENT = 'off';
  const mgr = new SessionManager({ stateDir, workspaceRoot: dir, claudePath: FAKE });
  const seen: GatewayEvent[] = [];
  mgr.subscribe((e) => seen.push(e));
  const argv = (): string[][] => readFileSync(join(dir, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  return { mgr, seen, argv, stateDir, dir };
}

async function settled(seen: GatewayEvent[], n: number, ms = 30_000): Promise<GatewayEvent> {
  const t0 = Date.now();
  for (;;) {
    const done = seen.filter((e) => e.kind === 'session_done');
    if (done.length >= n) return done[n - 1];
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for session_done #' + n);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The fake CLI exits after its result; wait until its process has left the pool. */
async function processGone(mgr: SessionManager, sid: string, ms = 10_000): Promise<void> {
  const pool = (mgr as unknown as { persistent: { hasLive(id: string): boolean } | null }).persistent;
  const t0 = Date.now();
  while (pool?.hasLive(sid)) {
    if (Date.now() - t0 > ms) throw new Error('process still live');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const flagValue = (args: string[], flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };

describe('a Claude conversation whose transcript is gone', () => {
  for (const persistent of [false, true]) {
    it(`continues in a fresh session with a recap instead of failing (${persistent ? 'persistent' : 'one-shot'})`, async () => {
      const f = managerFixture({ projectsTree: true, persistent });
      const sid = f.mgr.start('first ask about the mobile app');
      expect((await settled(f.seen, 1)).data.status).toBe('completed');
      const projectId = String(f.seen.find((e) => e.kind === 'session_started')?.data.projectId);
      expect(f.mgr.historyContext(projectId, sid).providerSessionId).toBe(sid);
      await processGone(f.mgr, sid);

      f.mgr.continueSession(projectId, sid, 'second ask');
      const done = await settled(f.seen, 2);
      expect(done.data, JSON.stringify(f.seen.filter((e) => e.kind === 'supervisor').map((e) => e.data))).toMatchObject({ status: 'completed' });
      const calls = f.argv();
      expect(calls).toHaveLength(2);
      const second = calls[1];
      expect(second).not.toContain('--resume');
      const newId = flagValue(second, '--session-id')!;
      expect(newId).toMatch(/^[0-9a-f-]{36}$/);
      expect(newId).not.toBe(sid);
      // Stored, so the NEXT turn resumes the new session.
      expect(f.mgr.historyContext(projectId, sid).providerSessionId).toBe(newId);
      const reset = f.seen.find((e) => e.kind === 'session_reset')!;
      expect(reset.data).toMatchObject({ reason: 'transcript_missing', previousSessionId: sid, newSessionId: newId, recapMessages: 1, sessionId: sid });
      expect(f.seen.some((e) => e.kind === 'supervisor' && e.data.type === 'session_reset')).toBe(true);
      if (!persistent) {
        // The recap reached the CLI; the display prompt did not get it.
        const prompt = second[second.length - 1];
        expect(prompt.startsWith('[Recovered context:')).toBe(true);
        expect(prompt).toContain('first ask about the mobile app');
        expect(prompt).toContain('second ask');
      }
      const started = f.seen.filter((e) => e.kind === 'session_started')[1];
      expect(started.data.displayPrompt).toBe('second ask');
      // The panel keeps the conversation's trail: still a continuation to it.
      expect(started.data).toMatchObject({ resume: true, freshSession: true });
      // One notice row in the journal (what a reload shows), before the prompt.
      const rows = new ConversationJournal(f.stateDir).turnSource(projectId, sid).rows;
      const notice = rows.find((r) => r.messageId === 'session-reset:' + newId)!;
      expect(notice).toMatchObject({ role: 'notice', text: sessionResetText(1) });
      expect(rows.filter((r) => r.role === 'user').map((r) => r.text)).toEqual(['first ask about the mobile app', 'second ask']);

      // The CLI writes the new session's transcript (the fake does not): the
      // next turn RESUMES the new id, with no recap and no second reset.
      const cwd = String(started.data.cwd);
      const projDir = join(f.dir, 'cfg-a', 'projects', claudeProjectDirName(realpathSync(cwd)));
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, newId + '.jsonl'), '{}\n');
      writeFileSync(join(f.dir, 'resume.jsonl'), [
        { event: { type: 'result', subtype: 'success', is_error: false, result: 'resumed' } }, { exit: 0 },
      ].map((l) => JSON.stringify(l)).join('\n'));
      await processGone(f.mgr, sid);
      f.mgr.continueSession(projectId, sid, 'third ask');
      expect((await settled(f.seen, 3)).data.status).toBe('completed');
      const third = f.argv()[2];
      expect(flagValue(third, '--resume')).toBe(newId);
      expect(f.seen.filter((e) => e.kind === 'session_reset')).toHaveLength(1);
      expect(f.mgr.historyContext(projectId, sid).providerSessionId).toBe(newId);
    }, 60_000);
  }

  it('a turn the CLI ends with "No conversation found" and no result reports that text', async () => {
    // No projects tree: the check cannot judge, so the turn resumes as before.
    const f = managerFixture({ projectsTree: false, persistent: false, resumeScenario: [{ stderr: 'No conversation found with session ID: X' }, { exit: 1 }] });
    const sid = f.mgr.start('hello');
    await settled(f.seen, 1);
    const projectId = String(f.seen.find((e) => e.kind === 'session_started')?.data.projectId);
    await processGone(f.mgr, sid);
    f.mgr.continueSession(projectId, sid, 'again');
    const done = await settled(f.seen, 2);
    expect(done.data.status).toBe('failed');
    expect(String(done.data.reason)).toContain('No conversation found with session ID: X');
    const failed = f.seen.find((e) => e.kind === 'supervisor' && e.data.type === 'turn_failed')!;
    expect(failed.data.error).toBe('No conversation found with session ID: X');
    expect(f.seen.some((e) => e.kind === 'session_reset')).toBe(false);
  }, 60_000);

  it('the error result alone (persistent process, code 0) reports errors[] too', async () => {
    const f = managerFixture({ projectsTree: false, persistent: true });
    const sid = f.mgr.start('hello');
    await settled(f.seen, 1);
    const projectId = String(f.seen.find((e) => e.kind === 'session_started')?.data.projectId);
    await processGone(f.mgr, sid);
    f.mgr.continueSession(projectId, sid, 'again');
    const done = await settled(f.seen, 2);
    expect(done.data.status).toBe('failed');
    expect(String(done.data.reason)).toContain('No conversation found with session ID: X');
    expect(String(done.data.reason)).not.toBe('exit code 0');
  }, 60_000);
});
