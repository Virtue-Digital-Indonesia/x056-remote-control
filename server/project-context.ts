import type { Project } from './projects.js';
import type { MemoryOwner } from './memory-access.js';
import type { ProjectSpaceRegistry } from './project-space-registry.js';

export interface ProjectContext {
  executionProjectId: string;
  sessionId?: string;
  parentProjectId?: string;
  spaceId?: string;
  workProjectId?: string;
  spaceArchived?: boolean;
  membershipRevision: number;
  inherited: boolean;
}

/** One server-owned interpretation of execution and parent identities. No caller
 * supplied parent can widen memory or file access. */
export class ProjectContextResolver {
  constructor(private readonly records: () => Project[], private readonly enabled: () => boolean, private readonly spaces?: ProjectSpaceRegistry) {}
  private batch?:{records:Project[];view?:ReturnType<ProjectSpaceRegistry['readView']>;enabled:boolean};
  withSnapshot<T>(work:()=>T):T {
    if(this.batch)return work();
    const view=this.spaces?.readView();this.batch={records:view?.projects||this.records(),view,enabled:this.enabled()};
    try{return work();}finally{this.batch=undefined;}
  }
  private readRecords(){return this.batch?.records||this.records();}
  private isEnabled(){return this.batch?.enabled??this.enabled();}
  resolve(projectId: string, sessionId?: string): ProjectContext {
    const records = this.readRecords(), target = records.find(p => p.id === projectId);
    if (!target) throw new Error('Project not found');
    if (sessionId && !target.conversations?.some(c => c.sessionId === sessionId)) throw new Error('Conversation not found');
    if (this.spaces) {
      // A repository without an explicit session is not a proxy for all its
      // individual overrides. Dispatch and agent reads must name a conversation.
      const resolved = this.isEnabled() && sessionId ? (this.batch?.view||this.spaces).resolve(projectId, sessionId) : undefined;
      return { executionProjectId: projectId, sessionId, workProjectId: target.kind === 'chat' ? undefined : projectId,
        spaceId: resolved?.spaceId, spaceArchived: resolved?.archived, membershipRevision: resolved?.membershipRevision || 0, inherited: !!resolved?.spaceId };
    }
    const parent = target.kind === 'chat' && target.parentProjectId && this.isEnabled()
      ? records.find(p => p.id === target.parentProjectId && p.kind !== 'chat' && !p.parentProjectId && !p.archivedAt) : undefined;
    return { executionProjectId: target.id, sessionId, parentProjectId: parent?.id,
      membershipRevision: target.membershipRevision ?? 0, inherited: !!parent };
  }
  spacesEnabled(): boolean { return this.isEnabled(); }
  validateMemoryOwner(owner: MemoryOwner): void {
    if (owner.kind === 'space') { if (!this.spaces) throw new Error('Project spaces unavailable'); if(this.batch?.view){if(!this.batch.view.state.spaces.some(s=>s.id===owner.id))throw new Error('Project space unavailable');}else this.spaces.get(owner.id, true); }
    else if (!this.readRecords().some(p=>p.id===owner.id)) throw new Error('Execution project not found');
  }
  memoryOwners() { return this.batch?.view?.state.ownerOverrides||this.spaces?.snapshot().ownerOverrides; }
  recipients(projectId: string, sessionId?: string): MemoryOwner[] {
    const scope = this.resolve(projectId,sessionId);
    return [{kind:'execution',id:projectId},...(scope.parentProjectId?[{kind:'execution' as const,id:scope.parentProjectId}]:[]),...(scope.spaceId?[{kind:'space' as const,id:scope.spaceId}]:[])];
  }
  memberOf(projectId: string, sessionId: string, spaceId: string): boolean {
    try { return this.resolve(projectId,sessionId).spaceId===spaceId; } catch { return false; }
  }
  sourceProjects(projectId: string): string[] {
    if (this.spaces) return [projectId]; // Exact Space member source filtering is separate from execution scope.
    const context = this.resolve(projectId), records = this.readRecords(), target = records.find(p => p.id === projectId)!;
    if (!this.isEnabled()) return [projectId];
    if (target.kind === 'chat') return [projectId, ...(context.parentProjectId ? [context.parentProjectId] : [])];
    return [projectId, ...records.filter(p => p.kind === 'chat' && p.parentProjectId === projectId && !target.archivedAt).map(p => p.id)];
  }
}
