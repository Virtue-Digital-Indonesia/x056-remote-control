import type { SessionManager } from './manager.js';
import type { ProjectSpaceRegistry } from './project-space-registry.js';

/** Counts use effective primary membership. Reference rows never become
 * executions and never contribute a second copy of a conversation. */
export function projectSpaceViews(manager: SessionManager, registry: ProjectSpaceRegistry) {
  const all = manager.listProjects().projects, state = registry.snapshot(), queues = manager.queues();
  const questions = new Set(manager.listPendingQuestions().map(q => q.sessionId));
  const scopes = new Map(all.flatMap(p => (p.conversations || []).map(c => [JSON.stringify([p.id, c.sessionId]), registry.resolve(p.id, c.sessionId)] as const)));
  return state.spaces.map(space => {
    const members = all.flatMap(p => (p.conversations || []).flatMap(c => {
      const scope = scopes.get(JSON.stringify([p.id, c.sessionId]))!;
      return scope.spaceId === space.id ? [{ projectId: p.id, sessionId: c.sessionId, mode: p.kind === 'chat' ? 'chat' as const : 'work' as const, title: c.title,
        provider: c.provider || p.provider || 'claude', inherited: scope.inherited, membershipRevision: scope.membershipRevision,
        running: p.runningSessionIds.includes(c.sessionId), background: p.backgroundSessionIds.includes(c.sessionId),
        needsInput: questions.has(c.sessionId), conversation: c }] : [];
    }));
    const workProjects = all.filter(p => p.kind !== 'chat' && (registry.defaultForWork(p.id) === space.id || members.some(m => m.projectId === p.id)))
      .map(p => ({ ...p, wholeProject: registry.defaultForWork(p.id) === space.id,
        conversations: (p.conversations || []).map(c => ({ ...c, spaceId: scopes.get(JSON.stringify([p.id, c.sessionId]))?.spaceId,
          membershipRevision: scopes.get(JSON.stringify([p.id, c.sessionId]))?.membershipRevision,
          included: scopes.get(JSON.stringify([p.id, c.sessionId]))?.spaceId === space.id })) }));
    const memberQueue = members.flatMap(m => (queues[m.projectId] || []).filter(q => q.sessionId === m.sessionId));
    return { ...space, members, workProjects, chats: all.filter(p => p.kind === 'chat' && members.some(m => m.projectId === p.id)),
      references: state.references.filter(r => r.spaceId === space.id), workspaceConfigured: workProjects.some(p => !!p.cwd),
      activity: { running: members.filter(m => m.running).length, background: members.filter(m => m.background).length,
        queued: memberQueue.length, waiting: memberQueue.filter(q => q.paused || q.contextReview || q.error).length, needsInput: members.filter(m => m.needsInput).length } };
  });
}
