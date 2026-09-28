import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';

afterEach(() => vi.useRealTimers());
describe('manager activity and completion integration', () => {
  it('keeps deployment safety conservative while clearing the UI, and waits on actual descendants before notification', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-activity-'));
    const stateDir = join(root, 'state');
    const registry = ProjectRegistry.load(join(stateDir, 'projects.json')), project = registry.create('Test', root);
    registry.addConversation(project.id, 'session', 'Test conversation', 'codex');
    const manager = new SessionManager({stateDir, workspaceRoot:root});
    let active = false;
    const spy = vi.spyOn(manager as any, 'pools').mockReturnValue([{
      workingSessions: () => [{sessionId:'session', busy:false, lastOutput:Date.now()}],
      activeSessions: () => active ? [
        {sessionId:'session', busy:true, active:false, parentActive:false, agents:0, tasks:0},
        {sessionId:'session', busy:false, active:true, parentActive:false, agents:1, tasks:0},
      ] : [],
      shutdown: () => {},
    }]);
    try {
      expect(manager.snapshot().backgroundProjects).toEqual([project.id]);
      expect(manager.listProjects().projects.find(p => p.id === project.id)?.backgroundSessionIds).toEqual([]);
      active = true;
      expect((manager as any).providerActivity('session')).toEqual({active:true, parentActive:false, agents:1, tasks:0});
      expect(manager.listProjects().projects.find(p => p.id === project.id)?.backgroundSessionIds).toEqual(['session']);
      const events: GatewayEvent[] = [];
      manager.subscribe(e => events.push(e));
      const emit = (kind: string, values: object = {}) => (manager as any).emit(kind, {projectId:project.id,sessionId:'session',...values});
      vi.useFakeTimers();
      emit('session_done', {status:'completed'});
      expect(events.at(-1)?.data.completionPending).toBe(true);
      vi.advanceTimersByTime(10000);
      expect(events.filter(e => e.kind === 'conversation_settled')).toHaveLength(0);
      active = false; emit('background_state', {active:false}); vi.advanceTimersByTime(3000);
      expect(events.filter(e => e.kind === 'conversation_settled')).toHaveLength(1);
      emit('session_done', {status:'completed'}); emit('session_started'); vi.advanceTimersByTime(3000);
      expect(events.filter(e => e.kind === 'conversation_settled')).toHaveLength(1);
    } finally { spy.mockRestore(); manager.onModuleDestroy(); rmSync(root,{recursive:true,force:true}); }
  });

  // GET /api/projects took 1.4-2.8 s in production: listProjects() computed the
  // background sessions once PER PROJECT, and each computation reloaded the
  // registry once per project too -- ~1,100 parses of projects.json per request
  // at 33 projects, synchronous, re-polled every second by every open panel.
  it('lists projects with a bounded number of registry reads, however many projects there are', () => {
    const root = mkdtempSync(join(tmpdir(), 'rc-list-'));
    const stateDir = join(root, 'state');
    const registry = ProjectRegistry.load(join(stateDir, 'projects.json'));
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const p = registry.create('P' + i, root);
      registry.addConversation(p.id, 's' + i, 'conversation ' + i, 'claude');
      ids.push(p.id);
    }
    const manager = new SessionManager({stateDir, workspaceRoot:root});
    const spy = vi.spyOn(manager as any, 'pools').mockReturnValue([{
      workingSessions: () => [{sessionId:'s7', busy:false, lastOutput:Date.now()}],
      activeSessions: () => [{sessionId:'s7', busy:false, active:true, parentActive:false, agents:1, tasks:0}],
      shutdown: () => {},
    }]);
    const loads = vi.spyOn(ProjectRegistry, 'load');
    try {
      const listed = manager.listProjects().projects;
      expect(listed.find(p => p.id === ids[7])?.backgroundSessionIds).toEqual(['s7']);
      expect(listed.filter(p => p.backgroundSessionIds.length).map(p => p.id)).toEqual([ids[7]]);
      // Was 1 + 30 * (1 + 30) = 931 here; independent of the project count now.
      expect(loads.mock.calls.length).toBeLessThanOrEqual(5);
    } finally { loads.mockRestore(); spy.mockRestore(); manager.onModuleDestroy(); rmSync(root,{recursive:true,force:true}); }
  });
});
