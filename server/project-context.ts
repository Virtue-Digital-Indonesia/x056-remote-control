import type { Project } from './projects.js';

export interface ProjectContext {
  executionProjectId: string;
  sessionId?: string;
  parentProjectId?: string;
  membershipRevision: number;
  inherited: boolean;
}

/** One server-owned interpretation of execution and parent identities. No caller
 * supplied parent can widen memory or file access. */
export class ProjectContextResolver {
  constructor(private readonly records: () => Project[], private readonly enabled: () => boolean) {}
  resolve(projectId: string, sessionId?: string): ProjectContext {
    const records = this.records(), target = records.find(p => p.id === projectId);
    if (!target) throw new Error('Project not found');
    if (sessionId && !target.conversations?.some(c => c.sessionId === sessionId)) throw new Error('Conversation not found');
    const parent = target.kind === 'chat' && target.parentProjectId && this.enabled()
      ? records.find(p => p.id === target.parentProjectId && p.kind !== 'chat' && !p.parentProjectId && !p.archivedAt) : undefined;
    return { executionProjectId: target.id, sessionId, parentProjectId: parent?.id,
      membershipRevision: target.membershipRevision ?? 0, inherited: !!parent };
  }
  sourceProjects(projectId: string): string[] {
    const context = this.resolve(projectId), records = this.records(), target = records.find(p => p.id === projectId)!;
    if (!this.enabled()) return [projectId];
    if (target.kind === 'chat') return [projectId, ...(context.parentProjectId ? [context.parentProjectId] : [])];
    return [projectId, ...records.filter(p => p.kind === 'chat' && p.parentProjectId === projectId && !target.archivedAt).map(p => p.id)];
  }
}
