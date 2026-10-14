/* The conversation menu (right-click, long-press) on every list that shows a conversation, and the
 * prompt taking focus on load. Isolated gateway only: seeded identities and fake providers. */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8786',token='browser-fixture-token-0123456789';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use the isolated localhost fixture');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);
  const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.stack));
  const check=(name,value)=>{assert(value,name);checks.push(name);};
  const api=async(path,data)=>{const r=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const space=await api('/api/project-spaces',{requestId:randomUUID(),name:'Menu Everywhere'});
  const chat=await api('/api/chats',{requestId:randomUUID(),name:'Proposal for menus',spaceId:space.id,provider:'claude'});
  const seed=await api('/api/projects'),work=seed.projects.find(p=>p.name==='Website refresh');
  const change={target:{kind:'work-project',projectId:work.id},assignment:{mode:'space',spaceId:space.id}},preview=await api('/api/project-spaces/membership/preview',change);
  await api('/api/project-spaces/membership/apply',{...change,operationId:randomUUID(),expectedRevision:preview.revision,expectedTopology:preview.topology,expectedImpactHash:preview.impactHash,expectedReviewHash:preview.reviewHash});
  const go=async path=>{await page.goto(base+path);await page.waitForTimeout(900);};
  const menuOn=async(selector,label)=>{
   const row=page.locator(selector).first();await row.waitFor({timeout:15000});
   await row.click({button:'right'});
   check(label+' opens the conversation menu',await page.getByRole('menuitem',{name:'Rename conversation',exact:true}).waitFor({timeout:4000}).then(()=>true,()=>false));
   await page.keyboard.press('Escape');await page.waitForTimeout(150);
  };
  const projectPath='/projects/'+space.id;
  await go(projectPath+'/overview');await menuOn('a.workspace-overview-row[data-conv-session]','Project overview row');
  await menuOn('footer a.cr-primary[data-conv-session]','Overview "Continue" link');
  await go(projectPath+'/chat');await menuOn('a.rc-space-conversation[data-conv-session]','Project Chat tab');
  await go(projectPath+'/work');await menuOn('a.rc-space-conversation[data-conv-session]','Project Work tab');
  await go('/chat');await menuOn('a.rc-chat-item[data-conv-session]','/chat list');
  await go('/work');await menuOn('.cr-task','/work board (unchanged)');
  // Left-click still navigates: the menu is only for right-click and long-press.
  await go('/chat');await page.locator('a.rc-chat-item[data-conv-session]').first().click();await page.waitForTimeout(500);
  check('left-click on a /chat row still opens the chat',/\/chat\//.test(page.url()));
  // Autofocus: after load the prompt has the caret, on desktop.
  await go('/chat/'+encodeURIComponent(chat.id));await page.waitForSelector('#prompt',{state:'visible',timeout:15000});await page.waitForTimeout(700);
  check('prompt is focused after a page load on a conversation',await page.evaluate(()=>document.activeElement&&document.activeElement.id==='prompt'));
  // It never steals focus from another field.
  await go('/chat/'+encodeURIComponent(chat.id));await page.evaluate(()=>{const i=document.createElement('input');i.id='probeField';document.body.appendChild(i);i.focus();});
  await page.evaluate(()=>window.rcFocusPrompt&&window.rcFocusPrompt());
  check('an input the user is typing in keeps focus',await page.evaluate(()=>document.activeElement&&document.activeElement.id==='probeField'));
  // Nor while a dialog is open.
  await page.evaluate(()=>{document.activeElement.blur();const d=document.createElement('dialog');d.id='probeDialog';document.body.appendChild(d);d.showModal();});
  check('no focus theft while a dialog is open',await page.evaluate(()=>window.rcFocusPrompt()===false));
  assert.deepEqual(errors,[]);
  console.log('PASS conversation menu on overview, project chat/work tabs and the /chat list; focus on load, never stolen:',checks.length,'checks');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
