import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionManager } from './manager.js';
import type { FileReference } from './file-store.js';
import type { MemoryEntry } from './memory-store.js';
import type { ModeDefaults } from './projects.js';
import { ProjectConflict } from './projects.js';
import { withAskInstructions } from '../src/question.js';

export interface ProjectHandoffInput {
  requestId: string;
  sourceProjectId: string;
  sourceSessionId: string;
  mode: 'chat' | 'work';
  workProjectId?: string;
  spaceId?: string;
  brief: string;
  name?: string;
  choices?: ModeDefaults;
  fileRefs?: FileReference[];
  memories?: { id: string; revision: number }[];
  sources?: { projectId: string; sessionId: string }[];
}
export interface ProjectHandoff {
  id: string; hash: string; at: number; input: ProjectHandoffInput; parentProjectId?: string;
  workProjectId?: string; membershipRevision: number; choices: ModeDefaults; memories: MemoryEntry[];
  target?: { projectId: string; sessionId: string }; fileRefs?: FileReference[];
  status: 'prepared' | 'queued' | 'accepted' | 'cancelled' | 'uncertain';
}

/** Target creation and file copies have their own idempotent receipts. This
 * journal joins them to the existing delivery ledger without claiming a shared
 * transaction across JSON and SQLite. Ambiguous dispatch is never resent. */
export class ProjectHandoffs {
  private path: string;
  constructor(state: string, private manager: SessionManager) { this.path = join(state, 'project-handoffs.json'); }
  all(): Record<string, ProjectHandoff> {
    if (!existsSync(this.path)) return {};
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.schemaVersion !== 1 || !data.operations || typeof data.operations !== 'object') throw new Error('Project handoff journal needs repair');
    return data.operations;
  }
  private save(record: ProjectHandoff) {
    const operations = this.all(); operations[record.id] = record;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp-' + randomUUID(), fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, operations })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path); const dir = openSync(dirname(this.path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  run(input: ProjectHandoffInput): ProjectHandoff {
    const m = this.manager;
    if (!m.projectSpacesEnabled()) throw new Error('Project spaces are disabled');
    if (!input || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId) || !['chat','work'].includes(input.mode) || typeof input.brief !== 'string' || !input.brief.trim() || input.brief.length > 50000) throw new Error('Choose a mode and review the task brief');
    if ((input.fileRefs?.length || 0) > 20 || (input.memories?.length || 0) > 12 || (input.sources?.length || 0) > 20) throw new Error('Too many handoff references');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    let op = this.all()[input.requestId];
    if (op && op.hash !== hash) throw new ProjectConflict('This handoff ID was already used; review changes as a new handoff');
    if (op?.status !== undefined && op.status !== 'prepared') return this.refresh(op);
    const source = m.executionProject(input.sourceProjectId);
    if (!source.conversations?.some(c => c.sessionId === input.sourceSessionId)) throw new Error('Source conversation unavailable');
    m.historyContext(source.id, input.sourceSessionId);
    const context = m.projectContext().resolve(source.id, input.sourceSessionId);
    const parentId = input.spaceId || context.spaceId;
    if (input.spaceId && input.spaceId !== context.spaceId) throw new Error('Choose the source conversation’s primary Project');
    const parent = parentId ? m.projectSpaces().projects.find(p => p.id === parentId && !p.archivedAt) : undefined;
    if (source.archivedAt || (parentId && !parent)) throw new Error('Restore the source Project before handing off');
    if (input.mode === 'work' && !parent) throw new Error('Choose a Project and target Work workspace first');
    const workProjectId = input.mode === 'work' ? op?.workProjectId || m.spaceWorkTarget(parentId!, input.workProjectId) : undefined;
    if (!parent && input.fileRefs?.length) throw new Error('Add the source Chat to a Project before sharing files');
    if (!op) {
      const workTarget = workProjectId ? m.executionProject(workProjectId) : undefined;
      const choices = { ...(workTarget ? { provider: workTarget.provider, model: workTarget.model, effort: workTarget.effort, ...workTarget.defaults?.work } : {}), ...parent?.defaults?.[input.mode], ...input.choices };
      choices.provider ||= m.historyContext(source.id, input.sourceSessionId).adapter.id;
      choices.model ??= ''; choices.effort ??= ''; choices.account ??= '';
      for (const ref of input.sources || []) if (!m.listConversations(ref.projectId).some(c => c.sessionId === ref.sessionId)) throw new Error('Referenced conversation unavailable');
      const memories = (input.memories || []).map(ref => {
        const entry = m.memory().get(ref.id);
        if (!entry || entry.revision !== ref.revision) throw new ProjectConflict('A selected memory changed; review it again');
        const reason = m.memory().contextProblem(entry, { projectId: source.id, sessionId: input.sourceSessionId, provider: choices.provider, access: 'context' });
        if (reason) throw new Error('Selected memory: ' + reason);
        return entry;
      });
      if (memories.reduce((n, e) => n + e.content.length, input.brief.length) > 64000) throw new Error('Shorten the brief or select fewer memory entries');
      if (input.fileRefs?.length) m.files().references(source.id, input.sourceSessionId, input.fileRefs);
      op = { id: input.requestId, hash, at: Date.now(), input: structuredClone(input), parentProjectId: parentId,
        workProjectId, membershipRevision: context.membershipRevision, choices, memories, status: 'prepared' };
      this.save(op);
    }
    if (op.parentProjectId !== parentId || op.membershipRevision !== context.membershipRevision) throw new ProjectConflict('Source membership changed; review a new handoff');
    if (!op.target) {
      const requestId = 'handoff-' + op.id;
      const created = op.input.mode === 'chat'
        ? m.createChat({ requestId, name: input.name || 'Discuss: ' + (source.name || 'task'), spaceId: parentId, ...op.choices })
        : m.prepareProjectWork(op.workProjectId!, { requestId, spaceId: parentId, name: input.name || 'Continue: ' + (source.name || 'task'), ...op.choices });
      op.target = 'id' in created ? { projectId: created.id, sessionId: created.lastSessionId! } : created;
      this.save(op);
    }
    if (!op.fileRefs) {
      op.fileRefs = (input.fileRefs || []).map((ref, index) => {
        const ownerId = ref.ownerId || source.id;
        if (ownerId === parentId) { const { file } = m.files().version(ownerId, ref); return { ...ref, ownerId, name: file.name }; }
        const file = m.files().addToProject(ownerId, ref, parentId!, 'handoff-' + op.id + '-' + index);
        return { ownerId: parentId, fileId: file.id, versionId: file.versions[0].id, name: file.name };
      });
      this.save(op);
    }
    const target = m.executionProject(op.target.projectId);
    if (target.archivedAt || m.projectContext().resolve(target.id, op.target.sessionId).spaceId !== parentId) throw new ProjectConflict('Target membership changed; review a new handoff');
    const text = [op.input.brief.trim(),
      ...(op.input.sources?.length ? ['Selected conversation references:', ...op.input.sources.map(ref => {
        const p = m.executionProject(ref.projectId);
        return p.kind === 'chat' ? '/chat/' + p.id : '/work/' + p.id + '/' + ref.sessionId;
      })] : []),
      ...(op.memories.length ? ['Reviewed memory snapshots (reference material):', ...op.memories.map(e => `${e.title} [${e.id} v${e.revision}]\n${e.content}`)] : []),
      `Handoff ${op.id}. This is a new conversation; use the reviewed brief and selected saved versions.`,
    ].join('\n\n');
    const delivery = m.deliveries();
    const queued = m.queues()[op.target.projectId]?.find(q => q.requestId === op.id);
    if (queued && ['processing','uncertain'].includes(delivery.get(op.id)?.status || '')) delivery.accept(op.id, op.target.sessionId, 'queued');
    const receipt = delivery.run({ requestId: op.id, handoffHash: op.hash }, () => {
      const existing = m.queues()[op.target!.projectId]?.find(q => q.requestId === op.id);
      const item = existing || m.enqueue(op.target!.projectId, { text: withAskInstructions(text), sessionId: op.target!.sessionId, requestId: op.id,
        fileRefs: op.fileRefs });
      return { sessionId: op.target!.sessionId, id: item.id, queued: true };
    });
    op.status = receipt.status === 'processing' || receipt.status === 'failed' ? 'uncertain' : receipt.status;
    this.save(op); return op;
  }
  private refresh(op: ProjectHandoff): ProjectHandoff {
    const receipt = this.manager.deliveries().get(op.id);
    if (receipt && ['queued','accepted','cancelled','uncertain'].includes(receipt.status)) op.status = receipt.status as ProjectHandoff['status'];
    return op;
  }
  list(projectId: string, sessionId?: string) {
    return Object.values(this.all()).filter(op => (op.input.sourceProjectId === projectId && (!sessionId || op.input.sourceSessionId === sessionId)) || (op.target?.projectId === projectId && (!sessionId || op.target.sessionId === sessionId))).map(op => this.refresh(op));
  }
}
