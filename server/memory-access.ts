import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export class MemoryConflict extends Error {}
export class MemoryReferenceConflict extends MemoryConflict {}
export interface MemoryOwner { kind: 'space' | 'execution'; id: string }
export interface MemorySubject { kind: 'entry' | 'source'; id: string }
export interface MemorySelection extends MemorySubject { version: string }
export interface MemoryGrant {
  id: string; revision: number; subject: MemorySubject; owner: MemoryOwner; recipient: MemoryOwner;
  permission: 'read'; active: boolean; createdAt: number; updatedAt: number;
}
export interface MemoryTurnReference extends MemorySelection {
  owner: MemoryOwner; grantId?: string; grantRevision?: number;
  allowReadForTurn: boolean; allowCrossProjectForTurn: boolean;
}
export interface MemoryReferenceSet {
  projectId: string; sessionId: string; requestId: string; revision: number;
  selections: MemoryTurnReference[]; updatedAt: number;
}
interface SubjectInfo { sessionId?:string;owner: MemoryOwner; version: string; available: boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameOwner = (a: MemoryOwner, b: MemoryOwner) => a.kind === b.kind && a.id === b.id;
function key(value: string, label: string) { if (typeof value !== 'string' || !/^[\w:-]{8,180}$/.test(value)) throw new Error('A stable ' + label + ' is required'); }
function owner(value: MemoryOwner) { if (!value || !['space','execution'].includes(value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 180) throw new Error('Choose a typed memory owner'); }
function subject(value: MemorySubject) { if (!value || !['entry','source'].includes(value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 180) throw new Error('Choose a memory entry or source'); }

/** Grants and deliberate turn references share the canonical memory database.
 * This service grants cited reading only; it has no file checkout capability. */
export class MemoryAccessStore {
  constructor(private db: DatabaseSync, private inspect: (subject: MemorySubject, version?: string) => SubjectInfo | undefined,
    private validateOwner: (owner: MemoryOwner) => void, private recipients: (pid: string, sid: string) => MemoryOwner[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_grants(id TEXT PRIMARY KEY,subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,recipient_kind TEXT NOT NULL,recipient_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(subject_kind,subject_id,recipient_kind,recipient_id));
      CREATE TABLE IF NOT EXISTS memory_reads(id TEXT PRIMARY KEY,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_access_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_turn_references(project_id TEXT NOT NULL,session_id TEXT NOT NULL,request_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,session_id,request_id));`);
  }
  private decode<T>(row: unknown): T | undefined { return row ? JSON.parse(String((row as { data: string }).data)) : undefined; }
  private mutation<T>(operationId: string, input: unknown, work: () => T): T {
    key(operationId, 'operationId'); const fingerprint = digest(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT fingerprint,data FROM memory_access_operations WHERE id=?').get(operationId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new MemoryConflict('operationId was used for a different memory access change');
        this.db.exec('COMMIT'); return this.decode<T>(old)!;
      }
      const result = work();
      this.db.prepare('INSERT INTO memory_access_operations VALUES(?,?,?)').run(operationId, fingerprint, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  grants(selection?: MemorySubject): MemoryGrant[] {
    if (selection) subject(selection);
    return this.db.prepare('SELECT data FROM memory_grants' + (selection ? ' WHERE subject_kind=? AND subject_id=?' : '')).all(...(selection ? [selection.kind,selection.id] : [])).map(row=>this.decode<MemoryGrant>(row)!);
  }
  grant(id: string): MemoryGrant | undefined { return this.decode(this.db.prepare('SELECT data FROM memory_grants WHERE id=?').get(id)); }
  setGrant(input: { operationId: string; subject: MemorySubject; expectedVersion: string; recipient: MemoryOwner; expectedRevision: number; active: boolean }): MemoryGrant {
    subject(input.subject); owner(input.recipient);
    return this.mutation(input.operationId, input, () => {
      this.validateOwner(input.recipient);
      const info = this.inspect(input.subject);
      if (!info || info.version !== input.expectedVersion) throw new MemoryConflict('The selected memory changed; review its current version');
      if (typeof input.active !== 'boolean' || (input.active && !info.available)) throw new Error('Share an available, reviewed memory');
      const previous = this.grants(input.subject).find(g => sameOwner(g.recipient,input.recipient));
      if ((previous?.revision || 0) !== input.expectedRevision) throw new MemoryConflict('Sharing changed; review the current recipients');
      const now=Date.now(), result:MemoryGrant = { id:previous?.id||randomUUID(), revision:(previous?.revision||0)+1, subject:input.subject, owner:info.owner, recipient:input.recipient,
        permission:'read', active:input.active, createdAt:previous?.createdAt||now, updatedAt:now };
      this.db.prepare('INSERT INTO memory_grants VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(result.id,result.subject.kind,result.subject.id,result.recipient.kind,result.recipient.id,JSON.stringify(result));
      return result;
    });
  }
  eligible(selection: MemorySubject, pid: string, sid: string): MemoryGrant | undefined {
    const info=this.inspect(selection); if (!info) return;
    const recipients=this.recipients(pid,sid);
    return this.grants(selection).find(g=>g.active&&sameOwner(g.owner,info.owner)&&recipients.some(r=>sameOwner(g.recipient,r)));
  }
  references(pid: string, sid: string, requestId?: string): MemoryReferenceSet | undefined {
    return requestId ? this.decode(this.db.prepare('SELECT data FROM memory_turn_references WHERE project_id=? AND session_id=? AND request_id=?').get(pid,sid,requestId)) : undefined;
  }
  setReferences(input: { operationId: string; projectId: string; sessionId: string; requestId: string; expectedRevision: number;
    selections: (MemorySelection & { allowReadForTurn?: boolean; allowCrossProjectForTurn?: boolean })[] }): MemoryReferenceSet {
    key(input.requestId,'message requestId');
    if (!Array.isArray(input.selections) || input.selections.length>12 || new Set(input.selections.map(s=>JSON.stringify([s.kind,s.id]))).size!==input.selections.length) throw new Error('Choose up to 12 distinct memory references');
    return this.mutation(input.operationId,input,()=>{
      const recipients=this.recipients(input.projectId,input.sessionId),previous=this.references(input.projectId,input.sessionId,input.requestId);
      if ((previous?.revision||0)!==input.expectedRevision) throw new MemoryConflict('Memory references changed; review them again');
      const selections = input.selections.map(s=>{
        subject(s); if (typeof s.version!=='string' || !s.version || s.version.length>180) throw new Error('Pin an exact memory revision or source version');
        for (const field of ['allowReadForTurn','allowCrossProjectForTurn'] as const) if (s[field]!==undefined&&typeof s[field]!=='boolean') throw new Error('Invalid turn permission');
        // Removing another selection must not renew a revoked grant or prevent review.
        const retained=previous?.selections.find(r=>r.kind===s.kind&&r.id===s.id&&r.version===s.version&&r.allowReadForTurn===!!s.allowReadForTurn&&r.allowCrossProjectForTurn===!!s.allowCrossProjectForTurn);
        if(retained)return structuredClone(retained);
        const info=this.inspect(s,s.version); if (!info?.available) throw new MemoryReferenceConflict('The selected memory version is unavailable or unconfirmed');
        const grant=this.eligible(s,input.projectId,input.sessionId),local=recipients.some(r=>sameOwner(r,info.owner))&&(!info.sessionId||(info.owner.kind==='execution'&&info.owner.id===input.projectId&&info.sessionId===input.sessionId));
        if (!local&&!grant&&!s.allowReadForTurn) throw new MemoryReferenceConflict('Allow reading this exact reference for this turn, or share it first');
        return {kind:s.kind,id:s.id,version:s.version,owner:info.owner,grantId:grant?.id,grantRevision:grant?.revision,
          allowReadForTurn:!!s.allowReadForTurn,allowCrossProjectForTurn:!!s.allowCrossProjectForTurn};
      });
      const result:MemoryReferenceSet={projectId:input.projectId,sessionId:input.sessionId,requestId:input.requestId,revision:(previous?.revision||0)+1,selections,updatedAt:Date.now()};
      this.db.prepare('INSERT INTO memory_turn_references VALUES(?,?,?,?) ON CONFLICT(project_id,session_id,request_id) DO UPDATE SET data=excluded.data').run(input.projectId,input.sessionId,input.requestId,JSON.stringify(result));
      return result;
    });
  }
  reference(selection:MemorySelection,pid:string,sid:string,requestId?:string):MemoryTurnReference|undefined {
    const ref=this.references(pid,sid,requestId)?.selections.find(s=>s.kind===selection.kind&&s.id===selection.id&&s.version===selection.version);
    if (!ref) return;
    const info=this.inspect(selection,selection.version);
    if (!info?.available||!sameOwner(info.owner,ref.owner)) throw new MemoryReferenceConflict('A selected memory is unavailable; review this message’s references');
    if (ref.grantId) {
      const grant=this.grant(ref.grantId),recipients=this.recipients(pid,sid);
      if (!grant?.active||grant.revision!==ref.grantRevision||!sameOwner(grant.owner,ref.owner)||!recipients.some(r=>sameOwner(r,grant.recipient))) throw new MemoryReferenceConflict('A memory sharing grant changed; review this message’s references');
    } else if (!ref.allowReadForTurn&&(!this.recipients(pid,sid).some(r=>sameOwner(r,info.owner))||(info.sessionId&&(info.owner.kind!=='execution'||info.owner.id!==pid||info.sessionId!==sid)))) throw new MemoryReferenceConflict('The selected memory’s owning Project changed; review this reference');
    return ref;
  }
  recordRead(selection:MemorySelection,pid:string,sid:string,requestId?:string,passages?:{id:string;locator:unknown}[]):void {
    const info=this.inspect(selection,selection.version);if(!info)return;
    const grant=this.eligible(selection,pid,sid),data={...selection,projectId:pid,sessionId:sid,requestId,owner:info.owner,grantId:grant?.id,grantRevision:grant?.revision,passages};
    this.db.prepare('INSERT INTO memory_reads VALUES(?,?,?)').run(randomUUID(),Date.now(),JSON.stringify(data));
    this.db.exec('DELETE FROM memory_reads WHERE id IN (SELECT id FROM memory_reads ORDER BY at DESC LIMIT -1 OFFSET 10000)');
  }
  assertGrant(id:string,revision:number,selection:MemorySubject,pid:string,sid:string):void {
    const grant=this.grant(id),info=this.inspect(selection);
    if (!grant?.active||grant.revision!==revision||!info||!sameOwner(grant.owner,info.owner)||!this.recipients(pid,sid).some(r=>sameOwner(r,grant.recipient))) throw new MemoryReferenceConflict('Memory access changed; review a continuation before resending this context');
  }
}
