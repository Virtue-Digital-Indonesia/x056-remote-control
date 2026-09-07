// Isolated gateway for browser checks. All identities and transcripts are fixtures.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/main.js';
import { AccountRegistry } from '../../src/accounts.js';
import { ProjectRegistry } from '../../server/projects.js';
import { AccountAnalytics } from '../../src/account-analytics.js';
const dir=mkdtempSync(join(tmpdir(),'x056-browser-')), state=join(dir,'state'), pub=join(dir,'public');
mkdirSync(state,{recursive:true});mkdirSync(pub);
for(const file of ['panel.html','control-room.js','control-room.css','webauthn.js','sw.js','manifest.webmanifest']) symlinkSync(file==='panel.html' && process.env.X056_TEST_PANEL ? process.env.X056_TEST_PANEL : resolve(['control-room.js','control-room.css'].includes(file) ? process.env.X056_TEST_ASSETS || 'server/public' : 'server/public',file),join(pub,file));
const specs=[{name:'primary',configDir:join(dir,'primary')},{name:'backup',configDir:join(dir,'backup')},{name:'chatgpt',configDir:join(dir,'chatgpt'),provider:'codex' as const}];
const registry=AccountRegistry.init(join(state,'accounts.json'),specs);registry.markOk('primary');registry.markLimited('backup',Math.floor(Date.now()/1000)+3600);registry.markOk('chatgpt');
for(const s of specs) { mkdirSync(s.configDir,{recursive:true});writeFileSync(join(s.configDir,'.claude.json'),JSON.stringify({oauthAccount:{displayName:s.name==='primary'?'Personal workspace':'Backup workspace',emailAddress:s.name+'@example.test'}})); }
const projects=ProjectRegistry.load(join(state,'projects.json'));
const many = process.env.X056_TEST_MANY === '1';
const p=projects.create('Website refresh',dir), p2=projects.create('Research workspace',dir);
const titles=['Build the new homepage','Review accessibility findings','Update the component library'];
let first='';
for(const title of titles){const sid=randomUUID();if(!first)first=sid;projects.addConversation(p.id,sid,title,'claude'); const transcriptDir=join(specs[0].configDir,'projects','fixture');mkdirSync(transcriptDir,{recursive:true});writeFileSync(join(transcriptDir,sid+'.jsonl'),Array.from({length:24},(_,i)=>JSON.stringify({type:i%2?'assistant':'user',uuid:randomUUID(),timestamp:new Date(Date.now()-(24-i)*60000).toISOString(),message:{role:i%2?'assistant':'user',content:[{type:'text',text:i%2?'The layout is ready to review.\n\nWe have simplified the navigation and improved the reading area. The next step is checking this conversation on desktop and mobile.':'Please improve the layout and keep the existing chat controls working.'}]}})).join('\n'));}
projects.addConversation(p2.id,randomUUID(),'Compare deployment options','claude');
if (many) {
  registry.markOk('backup');
  projects.addConversation(p2.id,randomUUID(),'ChatGPT research notes','codex');
  for (let i=1;i<=30;i++) {
    const project=projects.create('Project '+String(i).padStart(2,'0')+' — Client workspace',dir);
    for(let j=1;j<=20;j++) projects.addConversation(project.id,randomUUID(),'Conversation '+String(j).padStart(2,'0')+' — Review the implementation and customer feedback','claude');
  }
}
const pending = {[first]:{projectId:p.id,sessionId:first,question:'Which landing page should we publish?',options:['Main page','Campaign page'],at:new Date().toISOString()}};
if(many){const sid=projects.get(p.id)!.conversations!.find(c=>c.title==='Review accessibility findings')!.sessionId;pending[sid]={projectId:p.id,sessionId:sid,question:'The review is complete. What should I work on next?',options:[],at:new Date().toISOString()};}
writeFileSync(join(state,'questions.json'),JSON.stringify(pending));
const metrics=new AccountAnalytics(state);const a=metrics.begin('primary','claude','test-model');a.observe({type:'assistant',message:{id:'1',model:'test-model',usage:{input_tokens:3000,output_tokens:700,cache_read_input_tokens:5000}}});a.finish('completed');
const fake=resolve('test/bin/fake-claude');const scenario=join(dir,'scenario.jsonl');writeFileSync(scenario,[{event:{type:'system',subtype:'init'}},{delayMs:many?10000:1200},{event:{type:'assistant',message:{content:[{type:'text',text:'Fixture response received.'}],usage:{input_tokens:10,output_tokens:8}}}},{event:{type:'result',subtype:'success',is_error:false,result:'Fixture response received.'}},{exit:0}].map(x=>JSON.stringify(x)).join('\n'));process.env.X056_FAKE_SCENARIO=scenario;process.env.X056_FAKE_SCENARIO_RESUME=scenario;
const app=await createApp({token:'browser-fixture-token-0123456789',stateDir:state,workspaceRoot:dir,claudePath:fake,panelPath:join(pub,'panel.html')});
await app.listen(Number(process.env.X056_TEST_PORT||8768),'127.0.0.1');
console.log('Browser fixture ready at '+await app.getUrl());
