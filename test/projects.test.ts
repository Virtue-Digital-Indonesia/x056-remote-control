import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../server/projects.js';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';

function stateDir(): string { const d = mkdtempSync(join(tmpdir(), 'x056-proj-')); mkdirSync(join(d, 'state'), { recursive: true }); return join(d, 'state'); }

describe('ProjectRegistry', () => {
  it('creates, selects, records last session, and round-trips', () => {
    const f = join(stateDir(), 'projects.json');
    const r = ProjectRegistry.load(f);
    const p = r.create('Alpha', '/w/a');
    expect(r.currentId()).toBe(p.id); // first project auto-selected
    r.setLastSession(p.id, 'sess-1');
    const q = r.create('Beta', '/w/b');
    r.select(q.id);
    const reloaded = ProjectRegistry.load(f);
    expect(reloaded.currentId()).toBe(q.id);
    expect(reloaded.get(p.id)?.lastSessionId).toBe('sess-1');
    expect(reloaded.list().map((x) => x.name)).toEqual(['Alpha', 'Beta']);
  });
  it('missing file loads as empty', () => {
    expect(ProjectRegistry.load(join(stateDir(), 'nope.json')).list()).toEqual([]);
  });

  it('manages multiple conversations per project: add, select, rename, remove', () => {
    const f = join(stateDir(), 'projects.json');
    const r = ProjectRegistry.load(f);
    const p = r.create('Alpha', '/w/a');
    r.addConversation(p.id, 's1', 'Fix the bug');
    r.addConversation(p.id, 's2', 'Write docs');
    expect(r.conversations(p.id).map((c) => c.title)).toEqual(['Fix the bug', 'Write docs']);
    expect(r.get(p.id)?.lastSessionId).toBe('s2'); // newest is current

    r.selectConversation(p.id, 's1');
    expect(r.get(p.id)?.lastSessionId).toBe('s1');
    r.renameConversation(p.id, 's1', 'Fix the login bug');
    expect(r.conversations(p.id).find((c) => c.sessionId === 's1')?.title).toBe('Fix the login bug');

    // setLastSession upserts an unknown session as a conversation (resume/adopt path)
    r.setLastSession(p.id, 's3', 'Adopted');
    expect(r.conversations(p.id).map((c) => c.sessionId)).toEqual(['s1', 's2', 's3']);

    r.removeConversation(p.id, 's1'); // removing the current repoints to the newest remaining
    expect(r.conversations(p.id).map((c) => c.sessionId)).toEqual(['s2', 's3']);
    const reloaded = ProjectRegistry.load(f);
    expect(reloaded.conversations(p.id).map((c) => c.sessionId)).toEqual(['s2', 's3']);
    expect(() => r.selectConversation(p.id, 'gone')).toThrow(/unknown conversation/);
  });

  it('conversationProvider: a legacy conversation with no stamped provider stays Claude even after the project default moves to codex', () => {
    const f = join(stateDir(), 'projects.json');
    const r = ProjectRegistry.load(f);
    const p = r.create('Obscura', '/w/obscura'); // defaults to 'claude'
    r.addConversation(p.id, 'old-1', 'SaaS'); // pre-multi-provider conversation, no .provider stamped
    r.setProvider(p.id, 'codex'); // user starts a NEW codex conversation, flipping the project default
    r.addConversation(p.id, 'new-1', 'Codex', 'codex');
    // The OLD conversation must stay Claude — it predates multi-provider, full
    // stop — not silently become "whatever the project defaults to now".
    expect(r.conversationProvider(p.id, 'old-1')).toBe('claude');
    expect(r.conversationProvider(p.id, 'new-1')).toBe('codex');
    // A hypothetical not-yet-started session genuinely has nothing else to go
    // on, so it DOES read the project's current default.
    expect(r.conversationProvider(p.id, 'never-started')).toBe('codex');
  });

  it('migrateConversations backfills a pre-existing lastSessionId into a conversation', () => {
    const f = join(stateDir(), 'projects.json');
    writeFileSync(f, JSON.stringify({ current: 'p1', projects: [{ id: 'p1', name: 'Old', cwd: '/w', lastSessionId: 'legacy-sess' }] }));
    const r = ProjectRegistry.load(f);
    r.migrateConversations();
    expect(r.conversations('p1')).toEqual([{ sessionId: 'legacy-sess', title: 'Conversation 1', createdAt: expect.any(Number) }]);
  });
});

describe('SessionManager projects', () => {
  function mgr(sd: string) {
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    return new SessionManager({ stateDir: sd, workspaceRoot: '/', runSessionFn: (async () => ({ status: 'completed', finalAccount: 'a', failovers: 0 })) as never });
  }
  it('migrates an existing state.json session into a first project', () => {
    const sd = stateDir();
    writeFileSync(join(sd, 'state.json'), JSON.stringify({ lastSessionId: 'legacy-sess', cwd: '/tmp' }));
    const m = mgr(sd);
    const { current, projects } = m.listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('X056 Remote Control');
    expect(projects[0].lastSessionId).toBe('legacy-sess');
    expect(current).toBe(projects[0].id);
  });
  it('selecting a project repoints state.json at its session', () => {
    const sd = stateDir();
    const m = mgr(sd);
    const a = m.createProject('A', '/');
    const b = m.createProject('B', '/');
    // pretend A ran a session
    ProjectRegistry.load(join(sd, 'projects.json')).setLastSession(a.id, 'sess-A');
    m.selectProject(a.id);
    expect(JSON.parse(readFileSync(join(sd, 'state.json'), 'utf8')).lastSessionId).toBe('sess-A');
    m.selectProject(b.id);
    expect(JSON.parse(readFileSync(join(sd, 'state.json'), 'utf8')).lastSessionId).toBeUndefined();
    expect(m.snapshot().currentProjectId).toBe(b.id);
  });
});

describe('ProjectRegistry.reorder', () => {
  it('applies the given order and persists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-proj-order-'));
    const reg = ProjectRegistry.load(join(dir, 'projects.json'));
    const a = reg.create('A', join(dir, 'a')), b = reg.create('B', join(dir, 'b')), c = reg.create('C', join(dir, 'c'));
    reg.reorder([c.id, a.id, b.id]);
    expect(reg.list().map((p) => p.name)).toEqual(['C', 'A', 'B']);
    // survives a reload from disk
    expect(ProjectRegistry.load(join(dir, 'projects.json')).list().map((p) => p.name)).toEqual(['C', 'A', 'B']);
  });

  it('never drops a project the client did not know about (stale list)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-proj-order2-'));
    const reg = ProjectRegistry.load(join(dir, 'projects.json'));
    const a = reg.create('A', join(dir, 'a')), b = reg.create('B', join(dir, 'b'));
    const c = reg.create('C', join(dir, 'c')); // added after the client fetched its list
    reg.reorder([b.id, a.id]); // stale order, omits C
    expect(reg.list().map((p) => p.name)).toEqual(['B', 'A', 'C']);
    expect(reg.list().some((p) => p.id === c.id)).toBe(true);
  });

  it('ignores unknown/duplicate ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-proj-order3-'));
    const reg = ProjectRegistry.load(join(dir, 'projects.json'));
    const a = reg.create('A', join(dir, 'a')), b = reg.create('B', join(dir, 'b'));
    reg.reorder([b.id, 'ghost-id', b.id, a.id]);
    expect(reg.list().map((p) => p.name)).toEqual(['B', 'A']);
  });
});
