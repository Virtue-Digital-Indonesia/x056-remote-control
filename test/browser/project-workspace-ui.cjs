/* Isolated gateway only: seeded identities and fake providers. */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{mkdirSync,writeFileSync}=require('node:fs');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8786',token='browser-fixture-token-0123456789';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use the isolated localhost fixture');
const out='/tmp/project-workspace-ui';mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);
  const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.stack));
  let largeEstimate=false;
  await page.route('**/api/usage/all?*',async route=>{const response=await route.fetch();if(!largeEstimate)return route.fulfill({response});const data=await response.json();data.projectSpaces[0].cost.usd=90256.52;data.projectSpaces[0].usage.input=95900000000;await route.fulfill({response,json:data});});
  const check=(name,value)=>{assert(value,name);checks.push(name);};
  const api=async(path,data)=>{const r=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const seed=await api('/api/projects'),work=seed.projects.find(p=>p.name==='Website refresh'),other=seed.projects.find(p=>p.name==='Research workspace');
  const space=await api('/api/project-spaces',{requestId:randomUUID(),name:'Hotel Management'});
  const source=await api('/api/project-spaces',{requestId:randomUUID(),name:'X056 Platform'});
  for(const name of ['Obscura','AHU AI','AHU Pemeliharaan','DISC Recruitment','Novena Injector'])await api('/api/project-spaces',{requestId:randomUUID(),name});
  const change={target:{kind:'work-project',projectId:work.id},assignment:{mode:'space',spaceId:space.id}},preview=await api('/api/project-spaces/membership/preview',change);
  await api('/api/project-spaces/membership/apply',{...change,operationId:randomUUID(),expectedRevision:preview.revision,expectedTopology:preview.topology,expectedImpactHash:preview.impactHash,expectedReviewHash:preview.reviewHash});
  const chat=await api('/api/chats',{requestId:randomUUID(),name:'Proposal for hotel operations',spaceId:space.id,provider:'claude'});
  const outside=await api('/api/chats',{requestId:randomUUID(),name:'Standalone research',provider:'claude'});
  const brief=await api('/api/memory/entry',{entry:{spaceId:space.id,scope:'space',title:'Project brief',kind:'context',tags:['project-brief'],content:'Develop a hotel operations platform and its proposal. Keep agreed scope, reference files, and implementation decisions together.',status:'confirmed',pinned:true}});
  const upload=await context.request.post(base+'/api/project-spaces/'+space.id+'/files',{headers:{Authorization:'Bearer '+token,'x-upload-id':randomUUID()},multipart:{files:{name:'Hotel requirements.txt',mimeType:'text/plain',buffer:Buffer.from('Retain the original hotel requirements.')}}});assert(upload.ok(),await upload.text());
  const projectPath='/projects/'+space.id,chatPath='/chat/'+chat.id,workPath='/work/'+work.id+'/'+work.conversations[0].sessionId;
  const go=async(path)=>{await page.goto(base+path);await page.locator('body.rc-workspace-ready').waitFor();};
  const shot=async(name)=>page.screenshot({path:out+'/'+name+'.png',animations:'disabled'});
  await go(projectPath+'/overview');await page.locator('#rcOverviewCost strong').filter({hasText:'$'}).waitFor();
  await page.locator('#rcOverviewBrief').filter({hasText:'Develop a hotel operations platform'}).waitFor();
  check('Approved brief loaded',await page.locator('#rcOverviewBrief').textContent()==='Develop a hotel operations platform and its proposal. Keep agreed scope, reference files, and implementation decisions together.');
  check('Five Project sections in sidebar',await page.locator('.workspace-project-children a').count()===5);
  check('Only four utility links',await page.locator('.workspace-global-nav a:visible').count()===4);
  check('Project list gets most of the sidebar',await page.locator('#crProjectLinks').evaluate(e=>e.clientHeight>=450));
  check('One Settings entry',await page.locator('#crSettings').isHidden()&&await page.locator('#sidebarSettings').isVisible());
  check('No Dashboard, Artifacts, or Queue planner in navigation',await page.locator('#crProjectNav').getByText(/^(Dashboard|Artifacts|Queue planner)$/).filter({visible:true}).count()===0);
  check('Project detail pane has right padding',await page.locator('.workspace-overview-aside').evaluate(e=>parseFloat(getComputedStyle(e).paddingRight)>=20));
  check('Repositories not duplicated in sidebar',await page.locator('#crProjectLinks a').filter({hasText:'Website refresh'}).count()===0);
  check('Project total has lifetime label',(await page.locator('#rcOverviewCost').innerText()).includes('Recorded lifetime usage'));
  const costs=await api('/api/usage/all?budgetMs=1000'),cost=costs.projectSpaces.find(p=>p.projectId===space.id).cost.usd;
  check('Project cost agrees with exact membership',Math.abs(Number((await page.locator('#rcOverviewCost strong').textContent()).replace(/[^0-9.]/g,''))-cost)<0.011);
  await shot('overview-desktop');
  await page.locator('#rcOverviewEditBrief').click();await page.locator('.memory-editor-dialog').waitFor();
  check('Review opens the existing brief',await page.locator('.memory-editor-dialog h2').textContent()==='Edit memory');
  await page.locator('.memory-editor-dialog textarea[name=content]').fill('Updated approved hotel brief.');await page.locator('.memory-editor-dialog .cr-primary').click();await page.locator('#rcOverviewBrief').filter({hasText:'Updated approved hotel brief.'}).waitFor();
  const briefs=await api('/api/memory/search?'+new URLSearchParams({spaceId:space.id,tag:'project-brief',scope:'space',access:'library'}));
  check('Brief edit retains identity without duplication',briefs.items.length===1&&briefs.items[0].id===brief.id);
  await page.locator('#crAccountsTab').click();await page.waitForURL(base+'/accounts');await page.locator('#accountChart svg').waitFor();
  check('Accounts selected',await page.locator('#crAccountsTab').getAttribute('aria-current')==='page');
  check('Accounts charts and total retained',await page.locator('#accountModels').isVisible()&&await page.locator('#crProjectCosts').isVisible());
  await shot('accounts-desktop');await page.reload();await page.locator('#accountChart svg').waitFor();check('Accounts direct refresh',new URL(page.url()).pathname==='/accounts');
  await page.locator('#crAccounts .workspace-view-nav a[href="/accounts/tools"]').click();await page.locator('#workspaceToolChoice').waitFor();check('Tools stay under Accounts',await page.locator('#crAccountsTab').getAttribute('aria-current')==='page');await page.locator('#workspaceToolChoice select').selectOption(JSON.stringify([chat.id,chat.lastSessionId]));await page.locator('#workspaceToolChoice button').click();await page.locator('.rc-chat-tools-dialog').waitFor();await page.keyboard.press('Escape');await page.goBack();await page.locator('#accountChart svg').waitFor();
  await page.locator('#crCostDetails').click();await page.locator('#projectCostDetails [data-project="'+space.id+'"]').waitFor();await page.keyboard.press('Escape');
  await go(chatPath);await page.locator('#rcChatFiles').waitFor();await page.locator('#prompt').fill('Keep this unsent proposal draft.');
  check('Sidebar reachable in Chat',await page.locator('#crAccountsTab').isEnabled());
  check('Chat has its parent breadcrumb',(await page.locator('#crBreadcrumb').innerText()).includes('Hotel Management'));
  check('Selected Project section visible in sidebar',await page.locator('.workspace-project-children [aria-current=page]').evaluate(e=>{const r=e.getBoundingClientRect(),b=document.getElementById('crProjectLinks').getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom;}));
  await page.locator('#rcChatFiles').click();check('Chat file inspector opens',await page.locator('#rcChatInspector').isVisible());
  await page.locator('#rcChatPanelClose').click();check('File inspector closes on desktop',!await page.locator('#rcChatInspector').isVisible());
  await page.locator('#rcChatTools').click();await page.locator('[data-kind=mcp]').click();await page.locator('#rcToolsList').getByText('x056',{exact:true}).waitFor();await page.keyboard.press('Escape');
  await shot('chat-desktop');
  await page.locator('#crAccountsTab').click();await page.waitForURL(base+'/accounts');await page.goBack();await page.locator('#prompt').waitFor();
  check('Draft retained across navigation',await page.locator('#prompt').inputValue()==='Keep this unsent proposal draft.');await page.reload();await page.locator('#prompt').waitFor();check('Draft retained across reload',await page.locator('#prompt').inputValue()==='Keep this unsent proposal draft.');
  await page.locator('.workspace-project-children a').filter({hasText:'Work'}).click();await page.locator('[data-work-project]').waitFor();await shot('work-desktop');
  await go(workPath);await page.locator('#prompt').fill('Keep this Work draft.');await page.locator('#rcProjectContext').waitFor();check('Work keeps parent navigation',await page.locator('.workspace-project-children [aria-current=page]').innerText()==='Work\n3');
  await go(projectPath+'/files');await page.locator('[data-project-file]').waitFor();await page.locator('.rc-space-file-menu').click();
  check('File menu in top layer',await page.locator('#workspaceFileMenu').evaluate(e=>e.matches(':popover-open')));
  await page.getByRole('menuitem',{name:'Versions',exact:true}).click();await page.locator('.rc-space-dialog [data-preview]').click();await page.getByText('Retain the original hotel requirements.',{exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.locator('.rc-space-file-menu').click();await page.getByRole('menuitem',{name:'Use in conversation',exact:true}).click();await page.locator('.rc-space-dialog [data-execution]').filter({hasText:'Proposal for hotel operations'}).click();await page.waitForURL(base+chatPath);await page.locator('#prompt').waitFor();
  check('Shared file attaches without losing draft',await page.locator('#prompt').inputValue()==='Keep this unsent proposal draft.');
  const refs=await page.evaluate(({id,sid})=>JSON.parse(localStorage.getItem('x056_chat_attachments_'+id+'::'+sid)||'[]'),{id:chat.id,sid:chat.lastSessionId});check('Exact shared-file owner retained',refs.some(r=>r.ownerId===space.id&&r.versionId));
  await go(projectPath+'/memory');await page.locator('#rcProjectBody #crMemory').waitFor();await shot('memory-desktop');
  await page.locator('#crAccountsTab').click();await page.waitForURL(base+'/accounts');check('Global navigation leaves embedded Memory',!await page.locator('#rcProjectPage').isVisible());
  await go('/settings');await page.locator('[data-settings-page=general]').click();await page.locator('#stageVisible').uncheck();check('Switcher hidden',!await page.locator('#conversationStage').isVisible());await page.keyboard.press('Escape');await page.reload();await page.locator('body.rc-workspace-ready').waitFor();check('Switcher hide preference survives refresh',!await page.locator('#conversationStage').isVisible());
  await page.locator('[data-settings-page=general]').click();check('Styled switch control',await page.locator('#stageVisible').evaluate(e=>e.getAttribute('role')==='switch'&&getComputedStyle(e).appearance==='none'&&e.getBoundingClientRect().width===36));await page.locator('#stageVisible').focus();await page.keyboard.press('Space');check('Keyboard toggle restores switcher',await page.locator('#conversationStage').isVisible());await page.keyboard.press('Space');await page.keyboard.press('Escape');
  await page.locator('[data-settings-page=general]').click();await page.locator('#stageVisible').check();await page.keyboard.press('Escape');check('Switcher restored',await page.locator('#conversationStage').isVisible());
  const second=await context.newPage();await second.goto(base+'/accounts');await second.locator('body.rc-workspace-ready').waitFor();await page.locator('[data-settings-page=general]').click();await page.locator('#stageVisible').uncheck();await second.waitForFunction(()=>document.body.dataset.stageHidden==='true');check('Switcher preference syncs across tabs',!await second.locator('#conversationStage').isVisible());await page.keyboard.press('Escape');await second.close();
  for(const path of ['/home','/activity','/accounts','/activity/automations','/activity/outputs','/activity/queue','/accounts/tools','/memory','/settings','/projects','/chat','/work/unassigned']){
    await go(path);check('Direct route '+path,new URL(page.url()).pathname===path);check('No desktop overflow '+path,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await go('/work/unassigned');await page.locator('.cr-task').first().waitFor();check('Assigned Work excluded from unassigned',await page.locator('.cr-task[data-project="'+work.id+'"]').count()===0);check('Unassigned repository retained',await page.locator('.cr-task[data-project="'+other.id+'"]').count()>0);
  for(const [oldPath,target] of [['/dashboard','/accounts'],['/queue','/activity/queue'],['/automations','/activity/automations'],['/artifacts','/activity/outputs']]){await go(oldPath);await page.waitForURL(base+target);check('Legacy link resolves '+oldPath,new URL(page.url()).pathname===target);}
  await go('/activity');check('Activity has no duplicate New conversation action',await page.locator('#crNew').isHidden());await page.locator('#crBoard .workspace-view-nav a[href="/activity/queue"]').click();await page.locator('#plannerAdd').waitFor();check('Queue belongs to Activity',await page.locator('#workspaceActivity').getAttribute('aria-current')==='page');await page.locator('#plannerAdd').click();await page.locator('dialog[open] textarea[name=prompt]').waitFor();await page.keyboard.press('Escape');await page.reload();await page.locator('#plannerAdd').waitFor();check('Queue refresh retains Activity route',new URL(page.url()).pathname==='/activity/queue');
  await go('/chat/not-a-real-chat');await page.getByRole('heading',{name:'Chat unavailable',exact:true}).waitFor();check('Invalid Chat shows recovery action',await page.locator('#rcChatWelcomeNew').isVisible());
  await go('/accounts');check('Missing Chat state clears on navigation',!await page.locator('body').evaluate(e=>e.classList.contains('rc-chat-unavailable')));
  let releaseList,listStarted;const pendingList=new Promise(r=>listStarted=r),listGate=new Promise(r=>releaseList=r);
  await page.route('**/api/project-spaces',async route=>{const response=await route.fetch();listStarted();await listGate;await route.fulfill({response});});
  await page.locator('#crSpacesTab').click();await pendingList;await page.locator('#crAccountsTab').click();await page.waitForURL(base+'/accounts');releaseList();await page.waitForTimeout(150);await page.unroute('**/api/project-spaces');
  check('Stale Project load cannot replace Accounts',!await page.locator('#rcProjectPage').isVisible()&&await page.locator('#crProjectCosts').isVisible());
  largeEstimate=true;
  for(const width of [390,320,768]){
    await page.setViewportSize({width,height:844});
    for(const path of [projectPath+'/overview',projectPath+'/files',projectPath+'/memory',chatPath,workPath,'/accounts','/accounts/tools','/activity/queue','/activity/automations','/activity/outputs','/settings','/projects','/chat']){
      await go(path);await page.waitForTimeout(300);
      if(path==='/accounts'){await page.locator('.cr-cost-value').filter({hasText:'90,256'}).waitFor();check(width+'px large cost keeps breakdown inside card',await page.locator('#crCostDetails').evaluate(e=>e.getBoundingClientRect().right<=document.getElementById('crProjectCosts').getBoundingClientRect().right));}
      check(width+'px no page overflow '+path,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      check(width+'px no content overflow '+path,await page.evaluate(()=>[...document.querySelectorAll('#crWorkspace>.cr-page,#conversationSurface')].filter(e=>e.getClientRects().length&&!e.hidden&&getComputedStyle(e).visibility!=='hidden').every(e=>e.scrollWidth<=e.clientWidth+1)));
    }
    if(width===390){
      await go(projectPath+'/overview');await page.locator('#rcOverviewCost strong').filter({hasText:'$'}).waitFor();await shot('overview-mobile');
      await page.locator('#crProjects').click();await page.locator('#crAccountsTab').click();await page.waitForURL(base+'/accounts');await page.locator('#accountChart svg').waitFor();await shot('accounts-mobile');
      await go(chatPath);await page.locator('#rcChatFiles').click();check('Mobile file inspector fits',await page.locator('#rcChatInspector').evaluate(e=>e.getBoundingClientRect().right<=innerWidth));await page.locator('#rcChatPanelClose').click();
      await page.locator('#crProjects').click();await shot('navigation-mobile');await page.keyboard.press('Escape');check('Mobile drawer closes with Escape',!await page.locator('#controlRoom').evaluate(e=>e.classList.contains('projects-open')));await page.locator('#prompt').fill('Mobile draft retained.');await shot('chat-mobile');
    }
  }
  const signedOut=await browser.newContext(),login=await signedOut.newPage();login.on('pageerror',e=>errors.push(e.stack));await login.goto(base+'/accounts');await login.locator('#gateToken').fill(token);await login.locator('#gateTokenBtn').click();await login.locator('#accountChart svg').waitFor();check('Sign in directly to Accounts',new URL(login.url()).pathname==='/accounts');await signedOut.close();
  check('No JavaScript errors',errors.length===0);
  writeFileSync(out+'/checks.json',JSON.stringify({checks,errors,at:new Date().toISOString()},null,2));console.log(JSON.stringify({passed:checks.length,evidence:out,errors}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
