import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../server/projects.js';
import { ProjectSpaceRegistry, type MembershipChange, type SpaceTarget } from '../server/project-space-registry.js';
import { ProjectContextResolver } from '../server/project-context.js';

function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'space-registry-')), projectFile = join(state, 'projects.json');
  const projects = () => ProjectRegistry.load(projectFile), initial = projects();
  const work = initial.create('Website', state), other = initial.create('Research', state);
  initial.addConversation(work.id, 'first', 'First', 'codex'); initial.addConversation(work.id, 'second', 'Second');
  initial.setProviderSessionId(work.id, 'first', 'native-provider-id');
  initial.addConversation(other.id, 'research', 'Research');
  initial.createChat({ id: 'chat', kind: 'chat', name: 'Chat', cwd: state, lastSessionId: 'chat-session', conversations: [{ sessionId: 'chat-session', title: 'Chat', createdAt: 1 }] });
  const spaces = new ProjectSpaceRegistry(state, () => projects().list());
  const a = spaces.create({ requestId: 'space-create-a', name: 'Proposal' }), b = spaces.create({ requestId: 'space-create-b', name: 'Delivery' });
  const change = (target: SpaceTarget, assignment: MembershipChange['assignment'], includeOverrides?: boolean) => {
    const input = { target, assignment, ...(includeOverrides !== undefined ? { includeOverrides } : {}) };
    const p = spaces.preview(input), request = { ...input, operationId: 'change-' + Math.random(), expectedRevision: p.revision, expectedTopology: p.topology, expectedImpactHash: p.impactHash };
    request.operationId = request.operationId.replace('.', '-');
    return { preview: p, request, apply: () => spaces.apply(request) };
  };
  return { state, projects, projectFile, spaces, a, b, work, other, change };
}

describe('Project organization separate from execution', () => {
  it('resolves a Space separately from Work identity and disables inherited access without deleting assignments', () => {
    const f = fixture(); f.change({ kind: 'work-conversation', projectId: f.work.id, sessionId: 'first' }, { mode: 'space', spaceId: f.a.id }).apply();
    let enabled = true;
    const context = new ProjectContextResolver(() => f.projects().list(), () => enabled, f.spaces);
    expect(context.resolve(f.work.id, 'first')).toMatchObject({ executionProjectId: f.work.id, workProjectId: f.work.id, spaceId: f.a.id });
    expect(context.resolve(f.work.id, 'second').spaceId).toBeUndefined();
    expect(context.resolve(f.work.id).spaceId).toBeUndefined();
    expect(() => context.resolve(f.a.id, 'first')).toThrow('Project not found');
    enabled = false; expect(context.resolve(f.work.id, 'first').spaceId).toBeUndefined();
    expect(f.spaces.resolve(f.work.id, 'first').spaceId).toBe(f.a.id);
  });
  it('associates whole Work and individual conversations without changing execution records', () => {
    const f = fixture(), before = readFileSync(f.projectFile, 'utf8');
    const op = f.change({ kind: 'work-project', projectId: f.work.id }, { mode: 'space', spaceId: f.a.id }).apply();
    expect(op.affected.map(r => r.sessionId)).toEqual(['first', 'second']);
    expect(f.spaces.resolve(f.work.id, 'first')).toMatchObject({ spaceId: f.a.id, workProjectId: f.work.id, inherited: true });
    f.spaces.complete(op.id);
    const next = f.change({ kind: 'work-conversation', projectId: f.work.id, sessionId: 'first' }, { mode: 'space', spaceId: f.b.id }).apply();
    expect(next.affected.map(r => r.sessionId)).toEqual(['first']);
    expect(f.spaces.resolve(f.work.id, 'second').spaceId).toBe(f.a.id);
    expect(f.spaces.resolve(f.work.id, 'first')).toMatchObject({ spaceId: f.b.id, inherited: false });
    expect(readFileSync(f.projectFile, 'utf8')).toBe(before);
    expect(f.projects().get(f.work.id)?.conversations?.[0].providerSessionId).toBe('native-provider-id');
  });
  it('distinguishes Standalone from Inherit and preserves exceptions when the whole Work project changes', () => {
    const f = fixture(), whole: SpaceTarget = { kind: 'work-project', projectId: f.work.id }, one: SpaceTarget = { kind: 'work-conversation', projectId: f.work.id, sessionId: 'first' };
    f.change(whole, { mode: 'space', spaceId: f.a.id }).apply();
    f.change(one, { mode: 'standalone' }).apply();
    const preview = f.change(whole, { mode: 'space', spaceId: f.b.id });
    expect(preview.preview.exceptions).toEqual([{ projectId: f.work.id, sessionId: 'first', mode: 'standalone', spaceId: undefined }]);
    expect(preview.apply().affected.map(r => r.sessionId)).toEqual(['second']);
    expect(f.spaces.resolve(f.work.id, 'first').spaceId).toBeUndefined();
    f.change(one, { mode: 'inherit' }).apply();
    expect(f.spaces.resolve(f.work.id, 'first').spaceId).toBe(f.b.id);
    f.change(one, { mode: 'standalone' }).apply();
    f.change(whole, { mode: 'space', spaceId: f.a.id }, true).apply();
    expect(f.spaces.resolve(f.work.id, 'first').spaceId).toBe(f.a.id);
  });
  it('requires a fresh review if a Work conversation was created after preview, and includes future conversations after completion', () => {
    const f = fixture(), proposal = f.change({ kind: 'work-project', projectId: f.work.id }, { mode: 'space', spaceId: f.a.id });
    f.projects().addConversation(f.work.id, 'later', 'Later');
    expect(proposal.apply).toThrow('review'); expect(f.spaces.resolve(f.work.id, 'first').spaceId).toBeUndefined();
    const op = f.change({ kind: 'work-project', projectId: f.work.id }, { mode: 'space', spaceId: f.a.id }).apply();
    expect(() => f.spaces.assertReady(f.work.id)).toThrow('reconciled');
    f.spaces.complete(op.id); f.projects().addConversation(f.work.id, 'future', 'Future');
    expect(f.spaces.resolve(f.work.id, 'future').spaceId).toBe(f.a.id);
  });
  it('persists retry receipts and per-execution membership generations across restart', () => {
    const f = fixture(), proposal = f.change({ kind: 'work-conversation', projectId: f.work.id, sessionId: 'first' }, { mode: 'space', spaceId: f.a.id });
    const op = proposal.apply(), generation = f.spaces.resolve(f.work.id, 'first').membershipRevision;
    const reopened = new ProjectSpaceRegistry(f.state, () => f.projects().list());
    expect(reopened.apply(proposal.request)).toEqual(op);
    expect(() => reopened.apply({ ...proposal.request, assignment: { mode: 'standalone' } })).toThrow('operationId');
    expect(() => reopened.assertReady(f.work.id, 'first')).toThrow('reconciled');
    expect(() => reopened.assertReady(f.work.id, 'second')).not.toThrow();
    reopened.complete(op.id); expect(reopened.pending()).toEqual([]);
    expect(reopened.resolve(f.work.id, 'first').membershipRevision).toBe(generation);
    f.change({ kind: 'chat', projectId: 'chat' }, { mode: 'space', spaceId: f.b.id }).apply();
    expect(reopened.resolve(f.work.id, 'first').membershipRevision).toBe(generation);
  });
  it('keeps references out of primary membership and archives only effective primary members', () => {
    const f = fixture(); f.change({ kind: 'work-project', projectId: f.work.id }, { mode: 'space', spaceId: f.a.id }).apply();
    f.change({ kind: 'work-conversation', projectId: f.work.id, sessionId: 'second' }, { mode: 'space', spaceId: f.b.id }).apply();
    f.spaces.addReference(f.a.id, { kind: 'work-project', projectId: f.other.id }, f.spaces.snapshot().revision, 'reference-work-001');
    expect(f.spaces.members(f.a.id)).toEqual([{ projectId: f.work.id, sessionId: 'first' }]);
    expect(f.spaces.resolve(f.other.id, 'research').spaceId).toBeUndefined();
    const archived = f.spaces.archive(f.a.id, true, f.a.revision, f.spaces.topology(), 'archive-space-001');
    expect(archived.affected.map(r => r.sessionId)).toEqual(['first']);
    expect(f.spaces.resolve(f.work.id, 'first')).toMatchObject({ spaceId: f.a.id, archived: true });
    expect(f.spaces.resolve(f.work.id, 'second').archived).toBe(false);
    expect(() => f.spaces.get(f.a.id)).toThrow('Restore');
    expect(f.spaces.archive(f.a.id, false, f.spaces.get(f.a.id, true).revision, f.spaces.topology(), 'restore-space-001').state).toBe('pending');
  });
  it('rejects wrong target kinds, nonexistent sessions, archived destinations and stale settings', () => {
    const f = fixture();
    expect(() => f.spaces.preview({ target: { kind: 'work-project', projectId: 'chat' }, assignment: { mode: 'space', spaceId: f.a.id } })).toThrow('target');
    expect(() => f.spaces.resolve(f.work.id, 'missing')).toThrow('Conversation');
    expect(() => f.spaces.preview({ target: { kind: 'chat', projectId: 'chat' }, assignment: { mode: 'inherit' } })).toThrow('Only Work');
    f.spaces.update(f.a.id, 1, { name: 'Renamed' }); expect(() => f.spaces.update(f.a.id, 1, { name: 'Stale' })).toThrow('changed');
    f.spaces.archive(f.a.id, true, 2, f.spaces.topology(), 'archive-space-002');
    expect(() => f.change({ kind: 'chat', projectId: 'chat' }, { mode: 'space', spaceId: f.a.id })).toThrow('available');
  });
  it('refuses damaged registry state without overwriting it', () => {
    const f = fixture(), path = join(f.state, 'project-spaces.json'); writeFileSync(path, '{damaged');
    expect(() => f.spaces.create({ requestId: 'new-space-0001', name: 'New' })).toThrow('repair');
    expect(readFileSync(path, 'utf8')).toBe('{damaged');
  });
});
