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
