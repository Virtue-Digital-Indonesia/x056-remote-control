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
});
