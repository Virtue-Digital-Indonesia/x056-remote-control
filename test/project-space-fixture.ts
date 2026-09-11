import type { SessionManager } from '../server/manager.js';
import type { MembershipChange } from '../server/project-space-registry.js';
export function associate(m: SessionManager, change: MembershipChange, operationId = 'test-' + crypto.randomUUID()) {
  const p = m.previewProjectMembership(change);
  return m.applyProjectMembership({ ...change, operationId, expectedRevision: p.revision, expectedTopology: p.topology, expectedImpactHash: p.impactHash, expectedReviewHash: p.reviewHash });
}
export function moveChat(m: SessionManager, id: string, spaceId: string | null, operationId?: string) {
  return associate(m, { target: { kind: 'chat', projectId: id }, assignment: spaceId ? { mode: 'space', spaceId } : { mode: 'standalone' } }, operationId);
}
export function associateWork(m: SessionManager, id: string, spaceId: string) {
  return associate(m, { target: { kind: 'work-project', projectId: id }, assignment: { mode: 'space', spaceId } });
}
