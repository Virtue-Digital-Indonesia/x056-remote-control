import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { DOCUMENT_CONVERTER } from './documents.js';
import type { FileReference, FileVersion, ChatFile } from './file-store.js';
import type { MemoryStore, MemoryQuery, KnowledgeSource } from './memory-store.js';
import { MemoryConflict, type MemoryOwner } from './memory-access.js';

export const MEMORY_EXTRACTOR='rc-memory-extractor-1';
const extractorPath=fileURLToPath(new URL('../skills/rc-documents/scripts/extract_memory.py',import.meta.url));
const extractorFingerprint=createHash('sha256').update(readFileSync(extractorPath)).update(DOCUMENT_CONVERTER).digest('hex');
export const EXTRACTION_LIMITS={maxPages:1000,maxExpandedBytes:128*1024*1024,maxTextBytes:12*1024*1024,maxSeconds:60,maxMemoryBytes:512*1024*1024,passageChars:1800,overlapChars:200};
export type ExtractionState='queued'|'processing'|'ready'|'partial'|'failed'|'unsupported'|'needs_ocr'|'cancelled';
export interface PassageLocator {kind:'lines'|'paragraph'|'table-cell'|'page';heading?:string;startLine?:number;endLine?:number;paragraph?:number;table?:number;row?:number;cell?:number;page?:number;charStart?:number;charEnd?:number}
export interface ExtractedPassage {ordinal:number;locator:PassageLocator;text:string;hash:string}
export interface ExtractionResult {extractor:string;format:string;state:ExtractionState;warnings:string[];textBytes:number;passages:ExtractedPassage[];limits:typeof EXTRACTION_LIMITS}
export interface MemoryDocument {
 id:string;owner:MemoryOwner;file:FileReference&{ownerId:string};title:string;revision:number;generation:number;activeVersionId?:string;jobId:string;
 state:ExtractionState;excluded:boolean;warnings:string[];error?:string;createdAt:number;updatedAt:number;
}
export interface ExtractionJob {progress?:{phase:string;passages?:number;textBytes?:number};id:string;sourceId:string;generation:number;file:FileReference&{ownerId:string};format:string;blobHash:string;extractor:string;options:typeof EXTRACTION_LIMITS;cacheKey:string;state:ExtractionState;attempt:number;token?:string;createdAt:number;updatedAt:number;error?:string}
export interface MemoryPassage extends ExtractedPassage {id:string;sourceId:string;versionId:string;file?:FileReference&{ownerId:string};title:string;owner:MemoryOwner;estimatedTokens:number}
export interface SourceCitation {sourceId:string;versionId:string;passageId:string;locator:PassageLocator;file?:FileReference&{ownerId:string};sourceProjectId?:string;sourceSessionId?:string}
type FileReader=(ownerId:string,ref:FileReference)=>{file:ChatFile;version:FileVersion;path:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fts=(query:string)=>(query.match(/[\p{L}\p{N}_-]{2,}/gu)||[]).slice(0,48).map(t=>'"'+t.replace(/"/g,'""')+'"*').join(' OR ');
const same=(a:MemoryOwner,b:MemoryOwner)=>a.kind===b.kind&&a.id===b.id;

/** Document metadata, durable jobs, cache, and passages live in memory.sqlite.
 * FileStore remains the sole owner of the retained original bytes. */
export class MemoryDocuments {
 private reader?:FileReader;private running=false;private closed=false;private activeJob?:string;private abort?:()=>void;private changed=()=>{};
 constructor(private db:DatabaseSync,private store:MemoryStore,private stateDir:string){
  db.exec(`CREATE TABLE IF NOT EXISTS memory_documents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_extraction_jobs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_extraction_cache(cache_key TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_document_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_passages(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,version_id TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(source_id,version_id,ordinal));
   CREATE INDEX IF NOT EXISTS memory_passage_version ON memory_passages(source_id,version_id,ordinal);
   CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(id UNINDEXED,text,heading,tokenize='unicode61 remove_diacritics 2');`);
 }
 private decode<T>(row:unknown):T|undefined{return row?JSON.parse(String((row as {data:string}).data)):undefined;}
 private tx<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get(id:string):MemoryDocument|undefined{return this.decode(this.db.prepare('SELECT data FROM memory_documents WHERE id=?').get(id));}
 all():MemoryDocument[]{return this.db.prepare('SELECT data FROM memory_documents').all().map(r=>this.decode<MemoryDocument>(r)!);}
 jobs(sourceId?:string):ExtractionJob[]{return this.db.prepare('SELECT data FROM memory_extraction_jobs'+(sourceId?' WHERE source_id=?':'')).all(...(sourceId?[sourceId]:[])).map(r=>this.decode<ExtractionJob>(r)!);}
 job(id:string):ExtractionJob|undefined{return this.decode(this.db.prepare('SELECT data FROM memory_extraction_jobs WHERE id=?').get(id));}
 private save(doc:MemoryDocument){this.db.prepare('INSERT INTO memory_documents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(doc.id,JSON.stringify(doc));}
 private saveJob(job:ExtractionJob){this.db.prepare('INSERT INTO memory_extraction_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(job.id,job.sourceId,job.state,JSON.stringify(job));}
 start(reader:FileReader,changed=()=>{}){
  if(this.reader)return;this.reader=reader;this.changed=changed;
  this.tx(()=>{for(const job of this.jobs().filter(j=>j.state==='processing')){job.state='queued';job.token=undefined;job.updatedAt=Date.now();this.saveJob(job);const doc=this.get(job.sourceId);if(doc?.jobId===job.id&&!doc.excluded){doc.state='queued';this.save(doc);}}});
  this.kick();
 }
 close(){this.closed=true;this.abort?.();}
 private mutate<T>(operationId:string,input:unknown,work:()=>T):T{
  if(typeof operationId!=='string'||!/^[\w:-]{8,160}$/.test(operationId))throw new Error('A stable operationId is required');
  return this.tx(()=>{const previous=this.db.prepare('SELECT fingerprint,data FROM memory_document_operations WHERE id=?').get(operationId),fingerprint=hash(input);
   if(previous){if(previous.fingerprint!==fingerprint)throw new MemoryConflict('operationId was used for another source change');return this.decode<T>(previous)!;}
   const result=work();this.db.prepare('INSERT INTO memory_document_operations VALUES(?,?,?)').run(operationId,fingerprint,JSON.stringify(result));return result;});
 }
 register(input:{operationId:string;owner:MemoryOwner;file:FileReference&{ownerId:string};sourceId?:string;expectedRevision?:number;options?:Partial<typeof EXTRACTION_LIMITS>}):MemoryDocument {
  this.store.validateOwner(input.owner);
  if(input.file.ownerId!==input.owner.id)throw new Error('Choose a file owned by this memory bank; copy shared files before editing or indexing independently');
  if(!this.reader)throw new Error('Document processor unavailable');
  if(Object.keys(input.options||{}).some(key=>!(key in EXTRACTION_LIMITS)))throw new Error('Unknown extraction limit');
  const selected=this.reader(input.file.ownerId,input.file),options={...EXTRACTION_LIMITS,...input.options};
  for(const key of Object.keys(options) as (keyof typeof options)[])if(!Number.isSafeInteger(options[key])||options[key]<1||options[key]>EXTRACTION_LIMITS[key])throw new Error('Invalid extraction limit');
  if(options.overlapChars>=options.passageChars)throw new Error('Passage overlap must be smaller than passage size');
  const result=this.mutate(input.operationId,input,()=>{
   const previous=input.sourceId?this.get(input.sourceId):undefined;
   if(input.sourceId&&(!previous||previous.revision!==input.expectedRevision))throw new MemoryConflict('Source changed; review its current version');
   if(previous&&(!same(previous.owner,input.owner)||previous.file.fileId!==input.file.fileId))throw new Error('A source retains its owner and original file identity');
   const at=Date.now(),id=previous?.id||randomUUID(),generation=(previous?.generation||0)+1,format=extname(selected.file.name).slice(1).toLowerCase();
   const job:ExtractionJob={id:randomUUID(),sourceId:id,generation,file:{ownerId:input.file.ownerId,fileId:input.file.fileId,versionId:input.file.versionId},format,blobHash:selected.version.hash,extractor:MEMORY_EXTRACTOR,options,cacheKey:hash([selected.version.hash,format,MEMORY_EXTRACTOR,extractorFingerprint,options]),state:'queued',progress:{phase:'queued'},attempt:0,createdAt:at,updatedAt:at};
   for(const old of this.jobs(id).filter(j=>['queued','processing'].includes(j.state))){old.state='cancelled';old.token=undefined;this.saveJob(old);}
   const doc:MemoryDocument={id,owner:input.owner,file:job.file,title:selected.file.name,revision:(previous?.revision||0)+1,generation,activeVersionId:previous?.activeVersionId,jobId:job.id,state:'queued',excluded:previous?.excluded||false,warnings:[],createdAt:previous?.createdAt||at,updatedAt:at};
   if(doc.excluded)throw new Error('Restore this source before updating it');this.save(doc);this.saveJob(job);return doc;
  });if(this.activeJob&&this.activeJob!==result.jobId&&this.job(this.activeJob)?.sourceId===result.id)this.abort?.();this.changed();this.kick();return result;
 }
 cancel(input:{operationId:string;sourceId:string;expectedRevision:number}):MemoryDocument{
  const doc=this.mutate(input.operationId,input,()=>{const doc=this.get(input.sourceId);if(!doc||doc.revision!==input.expectedRevision)throw new MemoryConflict('Source changed; review it again');const job=this.job(doc.jobId);if(job&&['queued','processing'].includes(job.state)){job.state='cancelled';job.token=undefined;this.saveJob(job);}doc.generation++;doc.revision++;doc.state='cancelled';doc.updatedAt=Date.now();this.save(doc);return doc;});if(this.activeJob===doc.jobId)this.abort?.();this.changed();return doc;
 }
 setExcluded(id:string,excluded:boolean):void{
  const doc=this.get(id);if(!doc)return;
  doc.excluded=excluded;doc.revision++;doc.generation++;doc.updatedAt=Date.now();
  this.tx(()=>{if(excluded){const job=this.job(doc.jobId);if(job&&['queued','processing'].includes(job.state)){job.state='cancelled';job.token=undefined;this.saveJob(job);doc.state='cancelled';}}this.save(doc);});if(excluded&&this.activeJob===doc.jobId)this.abort?.();this.changed();
 }
 private kick(){if(!this.closed&&this.reader&&!this.running)setImmediate(()=>void this.drain());}
 private extract(path:string,job:ExtractionJob):Promise<ExtractionResult>{
  const dir=join(this.stateDir,'memory-extractions');mkdirSync(dir,{recursive:true});const output=join(dir,job.id+'-'+job.attempt+'.json');
  return new Promise((resolve,reject)=>{
   const python=process.env.X056_DOCUMENT_PYTHON||(existsSync('/opt/rc-documents/bin/python')?'/opt/rc-documents/bin/python':'python3');
   const child=spawn(python,[extractorPath,path,job.format,output,JSON.stringify(job.options)],{detached:true,stdio:['ignore','ignore','pipe']});
   let error='',timedOut=false;const kill=()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}};this.abort=kill;
   const timer=setTimeout(()=>{timedOut=true;kill();},job.options.maxSeconds*1000);
   child.stderr.on('data',data=>{error=(error+data).slice(-4000);});child.once('error',e=>{clearTimeout(timer);reject(e);});
   child.once('close',code=>{clearTimeout(timer);this.abort=undefined;try{if(code!==0)throw new Error(timedOut?'Extraction time limit exceeded':error||'Document extraction exceeded its limits or failed');if(statSync(output).size>64*1024*1024)throw new Error('Extraction output limit exceeded');const result=JSON.parse(readFileSync(output,'utf8')) as ExtractionResult;if(result.extractor!==MEMORY_EXTRACTOR||!Array.isArray(result.passages)||!Array.isArray(result.warnings))throw new Error('Invalid extraction result');resolve(result);}catch(e){reject(e);}finally{rmSync(output,{force:true});}});
  });
 }
 private async drain(){
  if(this.running||this.closed||!this.reader)return;this.running=true;
  try{while(!this.closed){const candidate=this.jobs().find(j=>j.state==='queued');if(!candidate)break;
   const job=this.tx(()=>{const j=this.job(candidate.id)!,doc=this.get(j.sourceId);if(j.state!=='queued')return;if(!doc||doc.excluded||doc.generation!==j.generation){j.state='cancelled';this.saveJob(j);return;}j.state='processing';j.progress={phase:'extracting'};j.attempt++;j.token=randomUUID();j.updatedAt=Date.now();doc.state='processing';this.saveJob(j);this.save(doc);return j;});if(!job)continue;this.activeJob=job.id;this.changed();
   try{const file=this.reader(job.file.ownerId,job.file);if(file.version.hash!==job.blobHash)throw new Error('Original file changed or is damaged');
    const cached=this.decode<ExtractionResult>(this.db.prepare('SELECT data FROM memory_extraction_cache WHERE cache_key=?').get(job.cacheKey));const result=cached||await this.extract(file.path,job);
    if(this.closed)break;
    // Check the selected file again after asynchronous extraction, including its hash.
    this.reader(job.file.ownerId,job.file);
    this.publish(job,result,file.version);
   }catch(e){if(this.closed)break;this.tx(()=>{const current=this.job(job.id),doc=this.get(job.sourceId);if(!current||current.token!==job.token||current.state!=='processing'||doc?.generation!==job.generation)return;current.state='failed';current.error=(e as Error).message.slice(0,2000);current.updatedAt=Date.now();this.saveJob(current);doc.state='failed';doc.error=current.error;doc.updatedAt=current.updatedAt;this.save(doc);});}
   this.activeJob=undefined;this.changed();
  }}finally{this.running=false;}
 }
 publish(job:ExtractionJob,result:ExtractionResult,file:FileVersion):boolean{
  // Store ingestion uses the same transaction through its explicit internal method.
  return this.tx(()=>{const current=this.job(job.id),doc=this.get(job.sourceId);if(!current||current.token!==job.token||current.state!=='processing'||!doc||doc.excluded||doc.generation!==job.generation||doc.jobId!==job.id)return false;
   if(!['ready','partial','failed','unsupported','needs_ocr'].includes(result.state))throw new Error('Invalid extractor status');
   if(!result.passages.length&&['ready','partial'].includes(result.state))throw new Error('Empty extraction cannot become ready');
   this.db.prepare('INSERT OR IGNORE INTO memory_extraction_cache VALUES(?,?)').run(job.cacheKey,JSON.stringify(result));
   if(result.passages.length&&['ready','partial'].includes(result.state)){
    const versionId=hash([doc.id,job.file.versionId,job.cacheKey]);
    const source=this.store.ingestDocumentInside({id:doc.id,key:'file:'+doc.id,kind:'document',title:doc.title,projectId:doc.owner.kind==='execution'?doc.owner.id:'',spaceId:doc.owner.kind==='space'?doc.owner.id:undefined,
     content:result.passages.map(p=>p.text).join('\n').slice(0,180000),at:Date.now(),versionId,document:{file:doc.file,contentHash:hash(result.passages.map(p=>[p.hash,p.locator])),extractor:job.extractor,cacheKey:job.cacheKey,format:job.format,coverage:result.state,warnings:result.warnings,sourceProjectId:file.sourceProjectId||undefined,sourceSessionId:file.sourceSessionId||undefined}});
    for(const raw of result.passages){const passage:MemoryPassage={...raw,id:hash([doc.id,versionId,raw.ordinal]),sourceId:doc.id,versionId,file:doc.file,title:doc.title,owner:doc.owner,estimatedTokens:Math.ceil(Buffer.byteLength(raw.text)/3)};
     this.db.prepare('INSERT OR IGNORE INTO memory_passages VALUES(?,?,?,?,?)').run(passage.id,doc.id,versionId,raw.ordinal,JSON.stringify(passage));this.db.prepare('DELETE FROM passage_fts WHERE id=?').run(passage.id);this.db.prepare('INSERT INTO passage_fts VALUES(?,?,?)').run(passage.id,raw.text,raw.locator.heading||'');}
    doc.activeVersionId=source.versionId;
   }
   current.state=result.state;current.progress={phase:'complete',passages:result.passages.length,textBytes:result.textBytes};current.token=undefined;current.updatedAt=Date.now();this.saveJob(current);doc.state=result.state;doc.warnings=result.warnings;doc.error=undefined;doc.updatedAt=current.updatedAt;doc.revision++;this.save(doc);return true;
  });
 }
 passages(sourceId:string,versionId:string):MemoryPassage[]{
  const source=this.store.sourceVersion(sourceId,versionId);if(!source)return [];
  if(source.document)return this.db.prepare('SELECT data FROM memory_passages WHERE source_id=? AND version_id=? ORDER BY ordinal').all(sourceId,versionId).map(r=>this.decode<MemoryPassage>(r)!);
  const rows:MemoryPassage[]=[];for(let start=0;start<source.content.length;start+=1600){const text=source.content.slice(start,start+1800);rows.push({id:hash([sourceId,versionId,start]),sourceId,versionId,title:source.title,owner:this.store.ownerOf(source),ordinal:rows.length,locator:{kind:'lines',charStart:start,charEnd:start+text.length,startLine:source.content.slice(0,start).split('\n').length},text,hash:hash(text),estimatedTokens:Math.ceil(Buffer.byteLength(text)/3)});if(start+1800>=source.content.length)break;}return rows;
 }
 selectedPassages(sourceId:string,versionId:string,query:string):MemoryPassage[]{
  const all=this.passages(sourceId,versionId),terms=(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)||[]).slice(0,48);if(!terms.length)return all;
  const score=(p:MemoryPassage)=>terms.reduce((n,t)=>n+(p.text.toLowerCase().includes(t)?1:0),0);
  return all.sort((a,b)=>score(b)-score(a)||a.ordinal-b.ordinal);
 }
 passage(id:string):MemoryPassage|undefined{return this.decode(this.db.prepare('SELECT data FROM memory_passages WHERE id=?').get(id));}
 search(q:MemoryQuery):{items:MemoryPassage[];total:number}{
  const term=fts(q.query||''),sql=term?'SELECT p.data FROM passage_fts JOIN memory_passages p ON p.id=passage_fts.id WHERE passage_fts MATCH ? ORDER BY bm25(passage_fts)':'SELECT data FROM memory_passages ORDER BY rowid DESC';
  const rows=this.db.prepare(sql).all(...(term?[term]:[])).map(r=>this.decode<MemoryPassage>(r)!).filter(p=>{const source=this.store.source(p.sourceId);return !!source&&source.versionId===p.versionId&&(q.access==='library'?!source.excluded&&this.store.sourceVisible(source,q):!this.store.sourceContextProblem(source,q));});
  const offset=Math.max(0,Number(q.offset)||0),limit=Math.max(1,Math.min(200,Number(q.limit)||20));return {items:rows.slice(offset,offset+limit),total:rows.length};
 }
 citation(p:MemoryPassage,source:KnowledgeSource):SourceCitation{return {sourceId:p.sourceId,versionId:p.versionId,passageId:p.id,locator:p.locator,file:p.file,sourceProjectId:source.document?.sourceProjectId||undefined,sourceSessionId:source.document?.sourceSessionId||undefined};}
}
