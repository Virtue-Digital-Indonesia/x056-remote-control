import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationJournal } from '../server/conversation-journal.js';
import { messageImages, uploadImage } from '../server/message-images.js';
const dirs: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(),'conversation-journal-')); dirs.push(p); return p; };
afterEach(() => dirs.splice(0).forEach(p => rmSync(p,{recursive:true,force:true})));
it('retains human dispatch and errors across reload and merges delayed provider echoes once', () => {
  const dir=temp(),journal=new ConversationJournal(dir),ts='2026-09-20T08:00:00Z';
  journal.record('session_started',{projectId:'p',sessionId:'s',messageId:'m',displayPrompt:'Queued prompt'},ts);
  journal.record('session_started',{projectId:'p',sessionId:'s',messageId:'m',displayPrompt:'Queued prompt'},ts);
  journal.record('session_error',{projectId:'p',sessionId:'s',message:'Provider disconnected'},'2026-09-20T08:00:02Z');
  expect(new ConversationJournal(dir).merge('p','s',[],true)).toHaveLength(2);
  const rows=journal.merge('p','s',[{role:'user',text:'Queued prompt',ts:'2026-09-20T08:00:01Z'}],true);
  expect(rows).toHaveLength(2);expect(rows[0].messageId).toBe('m');expect(rows[1].role).toBe('error');
  expect(journal.merge('other','s',[],true)).toEqual([]);
  expect(journal.merge('p','s',[{role:'assistant',text:'old',ts:'2026-09-19T00:00:00Z'}],false)).toHaveLength(1);
});
it('does not lose repeated equal prompts from separate turns', () => {
  const journal=new ConversationJournal(temp());
  for(let i=0;i<2;i++)journal.record('session_started',{projectId:'p',sessionId:'s',messageId:'m'+i,displayPrompt:'Continue'},new Date(1000+i*1000).toISOString());
  expect(journal.merge('p','s',[{role:'user',text:'Continue',ts:new Date(1000).toISOString()}],true)).toHaveLength(2);
});
it('finds historical uploaded images with spaces and saved-file versions only in attachment blocks', () => {
  const id='11111111-1111-1111-1111-111111111111';
  const text=`[The user attached a image (Screenshot 1.png). Read it with the Read tool at: /app/state/uploads/${id}/Screenshot 1.png]\n[Attached saved files. Read these paths.\n- "other.png" (ownerId=chat, fileId=file, versionId=v1, SHA-256=abc): /private/blob.png\n]`;
  const images=messageImages(text,id=>'/api/chats/'+id);
  expect(images.map(x=>x.name)).toEqual(['Screenshot 1.png','other.png']);
  expect(images[0].url).toContain('Screenshot%201.png');expect(images[1].url).toBe('/api/chats/chat/files/file/versions/v1/content');
  expect(messageImages('/app/state/uploads/'+id+'/Screenshot 1.png',()=>'/no')).toEqual([]);
});
it('refuses upload traversal, symlinks, and non-image files', () => {
  const dir=temp(),id='11111111-1111-1111-1111-111111111111',folder=join(dir,'uploads',id);mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'safe.png'),'png');writeFileSync(join(dir,'secret.png'),'secret');symlinkSync(join(dir,'secret.png'),join(folder,'link.png'));
  expect(uploadImage(dir,id,'safe.png').type).toBe('image/png');
  for(const name of ['../secret.png','link.png','secret.txt'])expect(()=>uploadImage(dir,id,name)).toThrow();
});

it('keeps stopped turns as neutral notices after reload', () => {
  const dir = temp(), journal = new ConversationJournal(dir);
  const data = { projectId:'p', sessionId:'s', requestId:'turn', status:'stopped', reason:'Stopped by user.' };
  journal.record('session_done', data, new Date().toISOString());
  journal.record('session_done', data, new Date().toISOString());
  expect(new ConversationJournal(dir).merge('p','s',[],true)).toMatchObject([{ role:'notice', text:'Stopped by user.' }]);
});
