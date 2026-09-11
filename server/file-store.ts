import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { constants, chmodSync, closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { ArtifactStore } from './workspace-store.js';
import type { Project } from './projects.js';
import { DOCUMENT_CONVERTER, documentCommand } from './documents.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BATCH_BYTES = 200 * 1024 * 1024;
export interface FileReference { fileId: string; versionId: string }
export interface ChatFile { id: string; chatId: string; sessionId: string; name: string; mime: string; latestVersionId: string; createdAt: string; removed: boolean; versions: FileVersion[] }
export interface FileVersion { id: string; fileId: string; parentVersionId?: string; hash: string; bytes: number; blob: string; artifactId: string; mime: string; createdAt: string; sourceMessageId?: string; account?: string }
interface Operation { state: string; fingerprint: string; result: string | null; epoch: number }
interface Checkout { token: string; chatId: string; fileId: string; versionId: string; path: string; epoch: number }
interface Prepared { name: string; mime: string; hash: string; bytes: number; blob: string }
export interface PreviewJob { id: string; chatId: string; versionId: string; converter: string; state: 'queued' | 'running' | 'ready' | 'failed' | 'unsupported'; output: string | null; error: string | null }
export class FileError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
const MIMES: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip' };
const now = () => new Date().toISOString();
// Vite 5 does not recognize Node 22's new built-in; keep it native in tests too.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Saved bytes are immutable. SQLite commits ownership, lineage, and retry receipts
 * together, after fsynced blobs exist. Orphan blobs are safe to retain after a crash. */
export class FileStore {
  private readonly db: SqliteDatabase;
  private readonly artifacts: ArtifactStore;
  readonly stagingDir: string;
  private workerRunning = false;
  private closed = false;
  constructor(private readonly state: string, private readonly owner: (id: string) => Project,
    private readonly changed: (chatId: string, data: Record<string, unknown>) => void = () => {},
    private readonly source: (chatId: string) => { sourceMessageId?: string; account?: string } = () => ({})) {
    mkdirSync(state, { recursive: true });
    this.stagingDir = join(state, 'file-staging'); mkdirSync(this.stagingDir, { recursive: true });
    mkdirSync(join(state, 'artifacts'), { recursive: true });
    this.db = new DatabaseSync(join(state, 'chat-files.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (schema.user_version > 1) throw new Error('Chat file catalog requires a newer gateway');
    if (!schema.user_version) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE files (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, sessionId TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, latestVersionId TEXT NOT NULL, createdAt TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX files_owner ON files(chatId,sessionId);
      CREATE TABLE versions (id TEXT PRIMARY KEY, fileId TEXT NOT NULL REFERENCES files(id), parentVersionId TEXT REFERENCES versions(id), hash TEXT NOT NULL, bytes INTEGER NOT NULL, blob TEXT NOT NULL, artifactId TEXT NOT NULL, mime TEXT NOT NULL, createdAt TEXT NOT NULL, sourceMessageId TEXT, account TEXT);
      CREATE TABLE operations (chatId TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, epoch INTEGER NOT NULL, PRIMARY KEY(chatId,id));
      CREATE TABLE epochs (chatId TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE checkouts (token TEXT PRIMARY KEY, chatId TEXT NOT NULL, fileId TEXT NOT NULL REFERENCES files(id), versionId TEXT NOT NULL REFERENCES versions(id), path TEXT NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE file_refs (requestId TEXT NOT NULL, chatId TEXT NOT NULL, fileId TEXT NOT NULL REFERENCES files(id), versionId TEXT NOT NULL REFERENCES versions(id), PRIMARY KEY(requestId,fileId,versionId));
      CREATE TABLE previews (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, versionId TEXT NOT NULL REFERENCES versions(id), converter TEXT NOT NULL, state TEXT NOT NULL, output TEXT, error TEXT, UNIQUE(versionId,converter));
      PRAGMA user_version=1; COMMIT;`);
    this.artifacts = new ArtifactStore(state, () => []);
    this.db.prepare("UPDATE previews SET state='queued',output=NULL WHERE state='running'").run();
    setImmediate(() => { void this.drainPreviews(); });
  }
  close(): void { this.closed = true; this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private writable(chatId: string): Project {
    const chat = this.owner(chatId);
    if (chat.archivedAt) throw new FileError('Restore this Chat before changing files', 409);
    return chat;
  }
  private operationId(id: string): void {
    if (typeof id !== 'string' || !/^[\w:-]{8,160}$/.test(id)) throw new FileError('A stable operationId is required');
  }
  epoch(chatId: string): number {
    return (this.db.prepare('SELECT epoch FROM epochs WHERE chatId=?').get(chatId) as { epoch: number } | undefined)?.epoch ?? 0;
  }
  /** Called at run start, account switch, and recovery to reject stale writers. */
  fence(chatId: string): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO epochs VALUES (?,1) ON CONFLICT(chatId) DO UPDATE SET epoch=epoch+1').run(chatId);
      this.db.prepare("UPDATE operations SET state='interrupted',error='Run changed; check out the saved version again' WHERE chatId=? AND state='pending'").run(chatId);
    });
    this.changed(chatId, { state: 'reconciled' });
  }
  list(chatId: string): ChatFile[] {
    const chat = this.owner(chatId);
    return (this.db.prepare('SELECT * FROM files WHERE chatId=? AND sessionId=? ORDER BY createdAt,id').all(chatId, chat.lastSessionId!) as unknown as ChatFile[])
      .map(file => ({ ...file, removed: !!file.removed, versions: this.db.prepare('SELECT * FROM versions WHERE fileId=? ORDER BY createdAt,rowid').all(file.id) as unknown as FileVersion[] }));
  }
  file(chatId: string, fileId: string): ChatFile {
    const file = this.list(chatId).find(f => f.id === fileId);
    if (!file) throw new FileError('File not found in this Chat', 404);
    return file;
  }
  setRemoved(chatId: string, fileId: string, removed: boolean): ChatFile {
    this.writable(chatId); this.file(chatId, fileId);
    if (typeof removed !== 'boolean') throw new FileError('removed must be boolean');
    // Keep every saved version and queued reference usable.
    this.db.prepare('UPDATE files SET removed=? WHERE id=? AND chatId=?').run(Number(removed), fileId, chatId);
    this.changed(chatId, { fileId, state: removed ? 'removed' : 'restored' });
    return this.file(chatId, fileId);
  }
  version(chatId: string, ref: FileReference): { file: ChatFile; version: FileVersion; path: string } {
    if (!ref || typeof ref.fileId !== 'string' || typeof ref.versionId !== 'string') throw new FileError('Invalid file reference');
    const file = this.file(chatId, ref.fileId), version = file.versions.find(v => v.id === ref.versionId);
    if (!version) throw new FileError('File version not found', 404);
    if (!/^[a-f0-9]{64}\.[a-z0-9]{1,12}$/.test(version.blob)) throw new FileError('Invalid retained file', 404);
    const path = join(this.state, 'artifacts', version.blob);
    try {
      if (realpathSync(path) !== join(realpathSync(this.state), 'artifacts', version.blob) || statSync(path).size !== version.bytes || createHash('sha256').update(readFileSync(path)).digest('hex') !== version.hash) throw new Error();
    } catch { throw new FileError('Saved file is missing or damaged', 404); }
    return { file, version, path };
  }
  private replay(chatId: string, id: string, fingerprint: string): string[] | undefined {
    this.operationId(id);
    const op = this.db.prepare('SELECT * FROM operations WHERE chatId=? AND id=?').get(chatId, id) as unknown as Operation | undefined;
    if (!op) return;
    if (op.fingerprint !== fingerprint) throw new FileError('operationId was used for different input', 409);
    if (op.state === 'committed') return JSON.parse(op.result!);
    throw new FileError('Operation was interrupted; check out the latest saved version with a new operationId', 409);
  }
  /** Snapshot through an open regular-file descriptor; enforce the cap on actual
   * streamed bytes too, as an agent may be writing concurrently. */
  private async prepare(source: string, name: string): Promise<Prepared> {
    if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new FileError('Invalid filename');
    const ext = extname(name).toLowerCase(), staged = join(this.stagingDir, randomUUID());
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    let bytes = 0, prefix = Buffer.alloc(0);
    const hash = createHash('sha256');
    try {
      const before = await input.stat();
      if (!before.isFile()) throw new FileError('Use a regular file');
      output = await open(staged, 'wx', 0o600);
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > MAX_FILE_BYTES) throw new FileError('File exceeds 50 MiB', 413);
        if (prefix.length < 8192) prefix = Buffer.concat([prefix, chunk.subarray(0, 8192 - prefix.length)]);
        hash.update(chunk); await output.writeFile(chunk);
      }
      const after = await input.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new FileError('File changed while saving; finish the edit before retrying', 409);
      await output.sync(); await output.close(); output = undefined;
      const checksum = hash.digest('hex');
      let mime = 'application/octet-stream';
      if (prefix.subarray(0, 5).toString() === '%PDF-') mime = 'application/pdf';
      else if (prefix.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
      else if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) mime = 'image/jpeg';
      else if (/^GIF8[79]a/.test(prefix.toString('ascii', 0, 6))) mime = 'image/gif';
      else if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
      else if (prefix.length >= 4 && prefix.readUInt32LE(0) === 0x04034b50) mime = ['.docx','.xlsx','.pptx'].includes(ext) ? MIMES[ext] : 'application/zip';
      else if (['.txt','.md','.csv','.json'].includes(ext)) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(staged)); } catch { throw new FileError('Text files must contain valid UTF-8'); }
        if (prefix.includes(0)) throw new FileError('Text file contains binary data');
        if (ext === '.json') { try { JSON.parse(readFileSync(staged, 'utf8')); } catch { throw new FileError('Invalid JSON file'); } }
        mime = MIMES[ext];
      }
      if (['.docx','.xlsx','.pptx','.zip'].includes(ext) && !mime.includes('openxmlformats') && mime !== 'application/zip') throw new FileError('Invalid Office or ZIP file');
      if (['.docx','.xlsx','.pptx','.zip'].includes(ext)) await documentCommand('validate', staged, ext);
      const safeExt = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '.bin', blob = checksum + safeExt;
      const target = join(this.state, 'artifacts', blob);
      // Identical blobs are interchangeable; rename only fully synced snapshots.
      renameSync(staged, target);
      chmodSync(target, 0o400);
      const fd = openSync(join(this.state, 'artifacts'), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      return { name, mime, hash: checksum, bytes, blob };
    } finally { await input.close(); await output?.close(); rmSync(staged, { force: true }); }
  }
  private insertVersion(chat: Project, fileId: string, data: Prepared, parent?: string, source?: { sourceMessageId?: string; account?: string }): FileVersion {
    const artifact = this.artifacts.registerRetained({ projectId: chat.id, sessionId: chat.lastSessionId!, title: data.name, file: data.blob, mime: data.mime, size: data.bytes });
    const version: FileVersion = { id: randomUUID(), fileId, parentVersionId: parent, hash: data.hash, bytes: data.bytes, blob: data.blob, artifactId: artifact.id, mime: data.mime, createdAt: now(), ...source };
    this.db.prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(version.id, fileId, parent ?? null, data.hash, data.bytes, data.blob, artifact.id, data.mime, version.createdAt, source?.sourceMessageId ?? null, source?.account ?? null);
    return version;
  }
  async upload(chatId: string, operationId: string, uploads: { path: string; name: string }[], expectedEpoch?: number): Promise<ChatFile[]> {
    this.writable(chatId); this.operationId(operationId);
    if (!uploads.length || uploads.length > 20) throw new FileError('Upload between 1 and 20 files');
    const prepared: Prepared[] = [];
    for (const item of uploads) {
      prepared.push(await this.prepare(item.path, item.name));
      if (prepared.reduce((n, f) => n + f.bytes, 0) > MAX_BATCH_BYTES) throw new FileError('Batch exceeds 200 MiB', 413);
    }
    const fingerprint = digest(['upload', prepared]);
    const ids = this.transaction(() => {
      const chat = this.writable(chatId), previous = this.replay(chatId, operationId, fingerprint);
      if (expectedEpoch !== undefined && expectedEpoch !== this.epoch(chatId)) throw new FileError('Run changed during output registration', 409);
      if (previous) return previous;
      const ids: string[] = [];
      for (const data of prepared) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,0)').run(id, chatId, chat.lastSessionId!, data.name, data.mime, '', now());
        const version = this.insertVersion(chat, id, data, undefined, expectedEpoch === undefined ? undefined : this.source(chatId));
        this.db.prepare('UPDATE files SET latestVersionId=? WHERE id=?').run(version.id, id); ids.push(id);
      }
      this.db.prepare("INSERT INTO operations VALUES (?,?,?,'committed',?,NULL,?)").run(chatId, operationId, fingerprint, JSON.stringify(ids), this.epoch(chatId));
      return ids;
    });
    this.changed(chatId, { operationId, fileIds: ids, state: 'saved' });
    return ids.map(id => this.file(chatId, id));
  }
  checkout(chatId: string, ref: FileReference): Checkout {
    const chat = this.writable(chatId), { file, path } = this.version(chatId, ref);
    if (file.removed) throw new FileError('Restore this file before editing', 409);
    const token = randomUUID(), folder = join(chat.cwd, 'files', token);
    mkdirSync(folder, { recursive: true });
    if (realpathSync(folder) !== folder) throw new FileError('Invalid working copy directory');
    const target = join(folder, file.name); copyFileSync(path, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    const checkout: Checkout = { token, chatId, fileId: file.id, versionId: ref.versionId, path: target, epoch: this.epoch(chatId) };
    this.db.prepare('INSERT INTO checkouts VALUES (?,?,?,?,?,?)').run(token, chatId, file.id, ref.versionId, target, checkout.epoch);
    return checkout;
  }
  async commit(chatId: string, fileId: string, input: { operationId: string; expectedBaseVersionId: string; checkoutToken: string; sourceMessageId?: string; account?: string }): Promise<ChatFile> {
    this.writable(chatId); this.operationId(input.operationId);
    const fingerprint = digest(['commit', fileId, input.expectedBaseVersionId, input.checkoutToken]);
    if (this.replay(chatId, input.operationId, fingerprint)) return this.file(chatId, fileId);
    const checkout = this.db.prepare('SELECT * FROM checkouts WHERE token=? AND chatId=? AND fileId=?').get(input.checkoutToken, chatId, fileId) as unknown as Checkout | undefined;
    if (!checkout || checkout.versionId !== input.expectedBaseVersionId) throw new FileError('Check out the expected saved version first', 409);
    const validate = () => {
      if (this.file(chatId, fileId).removed) throw new FileError('Restore this file before editing', 409);
      if (checkout.epoch !== this.epoch(chatId)) throw new FileError('Working copy belongs to a previous run; check out again', 409);
      if (this.file(chatId, fileId).latestVersionId !== input.expectedBaseVersionId) throw new FileError('A newer version exists; check it before saving', 409);
    };
    validate();
    const chat = this.writable(chatId);
    if (!realpathSync(checkout.path).startsWith(chat.cwd + sep) || realpathSync(checkout.path) !== checkout.path) throw new FileError('Working copy left this Chat');
    this.db.prepare("INSERT INTO operations VALUES (?,?,?,'pending',NULL,NULL,?)").run(chatId, input.operationId, fingerprint, checkout.epoch);
    try {
      const prepared = await this.prepare(checkout.path, this.file(chatId, fileId).name);
      this.transaction(() => {
        this.writable(chatId); validate();
        const version = this.insertVersion(chat, fileId, prepared, input.expectedBaseVersionId, this.source(chatId));
        this.db.prepare('UPDATE files SET latestVersionId=?,mime=? WHERE id=?').run(version.id, prepared.mime, fileId);
        this.db.prepare("UPDATE operations SET state='committed',result=? WHERE chatId=? AND id=?").run(JSON.stringify([version.id]), chatId, input.operationId);
      });
      this.changed(chatId, { fileId, operationId: input.operationId, state: 'saved' });
      return this.file(chatId, fileId);
    } catch (error) {
      this.db.prepare("UPDATE operations SET state='failed',error=? WHERE chatId=? AND id=? AND state='pending'").run((error as Error).message, chatId, input.operationId);
      throw error;
    }
  }
  references(chatId: string, sessionId: string, refs: FileReference[], requestId?: string): string {
    if (this.owner(chatId).lastSessionId !== sessionId || !Array.isArray(refs) || refs.length > 20) throw new FileError('Invalid Chat attachment association');
    return refs.map(ref => {
      const { file, version, path } = this.version(chatId, ref);
      if (requestId) this.db.prepare('INSERT OR IGNORE INTO file_refs VALUES (?,?,?,?)').run(requestId, chatId, ref.fileId, ref.versionId);
      return `- ${JSON.stringify(file.name)} (fileId=${file.id}, versionId=${version.id}, SHA-256=${version.hash}): ${path}`;
    }).join('\n');
  }

  async register(chatId: string, input: { operationId: string; path: string; name: string; epoch: number }): Promise<ChatFile> {
    const chat = this.writable(chatId);
    const path = realpathSync(input.path);
    if (path !== resolve(input.path) || !path.startsWith(chat.cwd + sep)) throw new FileError('Output must be a regular file inside this Chat');
    if (input.epoch !== this.epoch(chatId)) throw new FileError('Run changed; list saved files and reconcile this output before registering', 409);
    // Check the epoch again after async validation, before the upload transaction.
    const [file] = await this.upload(chatId, input.operationId, [{ path, name: input.name }], input.epoch);
    return file;
  }

  async restore(chatId: string, fileId: string, input: { versionId: string; expectedBaseVersionId: string; operationId: string }): Promise<ChatFile> {
    const fingerprint = digest(['restore', fileId, input.versionId, input.expectedBaseVersionId]);
    if (this.replay(chatId, input.operationId, fingerprint)) return this.file(chatId, fileId);
    const chat = this.writable(chatId), { file, version } = this.version(chatId, { fileId, versionId: input.versionId });
    this.transaction(() => {
      if (this.file(chatId, fileId).latestVersionId !== input.expectedBaseVersionId) throw new FileError('A newer version exists', 409);
      const saved = this.insertVersion(chat, fileId, { name: file.name, mime: version.mime, bytes: version.bytes, blob: version.blob, hash: version.hash }, input.expectedBaseVersionId);
      this.db.prepare('UPDATE files SET latestVersionId=?,mime=? WHERE id=?').run(saved.id, saved.mime, fileId);
      this.db.prepare("INSERT INTO operations VALUES (?,?,?,'committed',?,NULL,?)").run(chatId, input.operationId, fingerprint, JSON.stringify([saved.id]), this.epoch(chatId));
    });
    this.changed(chatId, { fileId, state: 'saved' }); return this.file(chatId, fileId);
  }

  preview(chatId: string, ref: FileReference, retry = false): PreviewJob {
    const { version } = this.version(chatId, ref);
    const supported = ['application/pdf', MIMES['.docx']].includes(version.mime);
    this.db.prepare('INSERT OR IGNORE INTO previews VALUES (?,?,?,?,?,NULL,NULL)').run(randomUUID(), chatId, version.id, DOCUMENT_CONVERTER, supported ? 'queued' : 'unsupported');
    if (retry) this.db.prepare("UPDATE previews SET state='queued',output=NULL,error=NULL WHERE versionId=? AND converter=? AND state IN ('failed','ready')").run(version.id, DOCUMENT_CONVERTER);
    const job = this.db.prepare('SELECT * FROM previews WHERE versionId=? AND converter=?').get(version.id, DOCUMENT_CONVERTER) as unknown as PreviewJob;
    setImmediate(() => { void this.drainPreviews(); });
    return job;
  }

  previewOutput(chatId: string, ref: FileReference, index: number): { path: string; mime: string } {
    const job = this.preview(chatId, ref);
    if (job.state !== 'ready') throw new FileError('Preview is not ready', 404);
    const outputs = JSON.parse(job.output!) as Prepared[], output = outputs[index];
    if (!Number.isInteger(index) || !output || !/^[a-f0-9]{64}\.(png|pdf)$/.test(output.blob)) throw new FileError('Preview page not found', 404);
    const path = join(this.state, 'artifacts', output.blob);
    if (!this.validPreview(output)) throw new FileError('Preview is missing or damaged; retry conversion', 404);
    return { path, mime: output.mime };
  }

  private validPreview(output: Prepared): boolean {
    if (!/^[a-f0-9]{64}\.(png|pdf)$/.test(output.blob)) return false;
    const path = join(this.state, 'artifacts', output.blob);
    try {
      return realpathSync(path) === join(realpathSync(this.state), 'artifacts', output.blob)
        && statSync(path).size === output.bytes
        && createHash('sha256').update(readFileSync(path)).digest('hex') === output.hash;
    } catch { return false; }
  }

  private async drainPreviews(): Promise<void> {
    if (this.closed || this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (!this.closed) {
        const job = this.db.prepare("SELECT * FROM previews WHERE state='queued' ORDER BY rowid LIMIT 1").get() as unknown as PreviewJob | undefined;
        if (!job) break;
        const workerId = randomUUID(), marker = JSON.stringify({ workerId });
        this.db.prepare("UPDATE previews SET state='running',output=? WHERE id=?").run(marker, job.id);
        const dir = join(this.stagingDir, workerId); mkdirSync(dir, { recursive: true });
        try {
          const version = this.db.prepare('SELECT * FROM versions WHERE id=?').get(job.versionId) as unknown as FileVersion;
          const { path, file } = this.version(job.chatId, { fileId: version.fileId, versionId: version.id });
          const cached = this.db.prepare("SELECT p.output FROM previews p JOIN versions v ON v.id=p.versionId WHERE v.hash=? AND v.mime=? AND p.converter=? AND p.state='ready' LIMIT 1")
            .get(version.hash, version.mime, job.converter) as { output: string } | undefined;
          let outputs: Prepared[] = cached ? JSON.parse(cached.output) : [];
          if (!outputs.length || !outputs.every(output => this.validPreview(output))) {
            outputs = [];
            const converted = await documentCommand('preview', path, dir);
            for (const output of [converted.pdf, ...converted.pages]) {
              if (typeof output !== 'string' || (output !== path && !realpathSync(output).startsWith(realpathSync(dir) + sep))) throw new Error('Invalid converter output');
              outputs.push(await this.prepare(output, basename(output)));
            }
          }
          if (this.closed) return;
          const update = this.db.prepare("UPDATE previews SET state='ready',output=?,error=NULL WHERE id=? AND state='running' AND output=?").run(JSON.stringify(outputs), job.id, marker);
          if (update.changes) {
            for (const output of outputs) this.artifacts.registerRetained({ projectId: job.chatId, sessionId: file.sessionId, title: file.name + ' preview', file: output.blob, mime: output.mime, size: output.bytes });
            this.changed(job.chatId, { fileId: file.id, versionId: job.versionId, previewId: job.id, state: 'ready' });
          }
        } catch (error) {
          if (!this.closed) {
            this.db.prepare("UPDATE previews SET state='failed',output=NULL,error=? WHERE id=? AND state='running' AND output=?").run((error as Error).message, job.id, marker);
            this.changed(job.chatId, { versionId: job.versionId, previewId: job.id, state: 'failed' });
          }
        } finally { rmSync(dir, { force: true, recursive: true }); }
      }
    } finally { this.workerRunning = false; }
  }
}
