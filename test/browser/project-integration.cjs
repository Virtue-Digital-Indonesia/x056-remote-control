const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8774';
const token = 'browser-fixture-token-0123456789';
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,data)=>{const response=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(response.ok(),await response.text());return response.json();};
  const original=await api('/api/projects'),work=original.projects.find(p=>p.name==='Website refresh'),other=original.projects.find(p=>p.name==='Research workspace');
  const suffix=Date.now(),name='Integrated proposal '+suffix;
  await page.goto(base+'/projects');await page.locator('#rcSpaceNew').click();await page.locator('.rc-space-dialog input[name=name]').fill(name);await page.locator('.rc-space-dialog .cr-primary').click();await page.locator('#rcSpaceAddExisting').waitFor();
  const aId=new URL(page.url()).pathname.split('/')[2], b=await api('/api/project-spaces',{requestId:'browser-space-'+suffix,name:'Research proposal '+suffix});
  const add=async(spaceId,kind,search,label,reference=false)=>{
    await page.goto(base+'/projects/'+spaceId+'/chat');await page.locator('#rcSpaceAddExisting').click();await page.locator('.rc-space-dialog input[value="'+kind+'"]').check();await page.locator('.rc-space-dialog input[type=search]').fill(search);
    await page.locator('.rc-space-picker-results [data-pick]').filter({hasText:label}).first().click();await page.locator('[data-preview]').waitFor();
    if(reference)await page.locator('.rc-space-dialog select[name=action]').selectOption('reference');
    await page.locator('[data-preview]').click();await page.locator('.rc-space-dialog .cr-primary:not([disabled])').waitFor();await page.locator('.rc-space-dialog .cr-primary').click();await page.locator('.rc-space-dialog').waitFor({state:'detached'});
  };
  await add(aId,'work-project','Website refresh','Website refresh');
  await page.locator('.rc-space-tabs a').filter({hasText:'Work'}).click();await page.locator('[data-work-project="'+work.id+'"]').waitFor();assert.match(await page.locator('[data-work-project]').innerText(),/includes future conversations/);
  const selected=work.conversations.find(c=>c.title==='Review accessibility findings');
  await add(b.id,'work-conversation','Review accessibility','Review accessibility findings');
  await page.goto(base+'/projects/'+aId+'/work');await page.locator('.rc-space-exception').waitFor();assert.match(await page.locator('.rc-space-exception').innerText(),/Research proposal/);
  const after=await api('/api/projects'),same=after.projects.find(p=>p.id===work.id);assert.equal(same.cwd,work.cwd);assert.deepEqual(same.conversations.map(c=>[c.sessionId,c.provider,c.providerSessionId]),work.conversations.map(c=>[c.sessionId,c.provider,c.providerSessionId]));
  assert.equal(same.conversations.find(c=>c.sessionId===selected.sessionId).spaceId,b.id);assert(same.conversations.filter(c=>c.sessionId!==selected.sessionId).every(c=>c.spaceId===aId));
  await add(b.id,'work-project','Website refresh','Website refresh',true);
  const view=await api('/api/project-spaces/'+b.id);assert.equal(view.references.length,1);assert.equal(view.members.length,1);
  await page.goto(base+'/projects/'+b.id+'/work');await page.locator('#rcSpaceNewConversation').click();await page.locator('.rc-space-dialog select[name=workProjectId]').selectOption(other.id);await page.locator('.rc-space-dialog input[name=name]').fill('New Work in original research repository');await page.locator('.rc-space-dialog select[name=provider]').selectOption('claude');await page.locator('.rc-space-dialog .cr-primary').click();await page.waitForURL(/\/work\/[^/]+\/[^/]+$/);
  const workPath=new URL(page.url()).pathname;assert.equal(workPath.split('/')[2],other.id);await page.locator('#prompt').fill('Unsent Work integration draft');await page.locator('#crBreadcrumb a[href^="/projects/"]').waitFor();assert.match(await page.locator('#crBreadcrumb').innerText(),/Research proposal/);
  await page.locator('#crBreadcrumb a[href^="/projects/"]').click();await page.locator('.rc-space-tabs a').filter({hasText:'Files'}).click();await page.locator('#rcSpaceUploadInput').setInputFiles({name:'提案.txt',mimeType:'text/plain',buffer:Buffer.from('Saved integration original')});await page.locator('[data-project-file]').waitFor();await page.locator('.rc-space-file-menu').click();await page.getByRole('menuitem',{name:'Use in conversation',exact:true}).click();await page.locator('.rc-space-dialog [data-execution]').filter({hasText:'New Work in original'}).click();await page.waitForURL(base+workPath);assert.equal(await page.locator('#prompt').inputValue(),'Unsent Work integration draft');
  await page.reload();await page.locator('#chatTools').waitFor();assert.equal(await page.locator('#prompt').inputValue(),'Unsent Work integration draft');
  await page.goto(base+'/projects/'+b.id+'/chat');await page.locator('#rcSpaceNewConversation').click();await page.locator('.rc-space-dialog input[name=name]').fill('Proposal Chat '+suffix);await page.locator('.rc-space-dialog select[name=provider]').selectOption('claude');await page.locator('.rc-space-dialog .cr-primary').click();await page.locator('#rcChatFiles').waitFor();const chatPath=new URL(page.url()).pathname;await page.locator('#prompt').fill('Unsent Chat integration draft');
  await page.locator('#moreBtn').click();await page.getByRole('menuitem',{name:'Change Project'}).click();await page.locator('.rc-space-dialog select[name=destination]').selectOption(aId);await page.locator('[data-preview]').click();await page.locator('.rc-space-dialog .cr-primary:not([disabled])').click();await page.locator('.rc-space-dialog').waitFor({state:'detached'});assert.equal(new URL(page.url()).pathname,chatPath);assert.equal(await page.locator('#prompt').inputValue(),'Unsent Chat integration draft');
  await page.goto(base+'/projects/'+aId+'/settings');await page.locator('#rcSpaceSettings').waitFor();assert.equal(await page.locator('#rcSpaceSettings input[name=cwd]').count(),0);await page.locator('#rcSpaceSettings select[name=workProjectId]').selectOption(work.id);await page.locator('#rcSpaceSettings .cr-primary').click();await page.locator('#rcSpaceSettings').waitFor();
  await page.goto(base+'/work/'+work.id);await page.locator('#rcCreateFromWork').waitFor();await page.reload();await page.locator('#rcCreateFromWork').waitFor();await page.locator('#rcCreateFromWork').click();await page.locator('.rc-space-dialog input[name=name]').waitFor();assert.equal(await page.locator('.rc-space-dialog input[name=name]').inputValue(),work.name);await page.keyboard.press('Escape');
  await page.goto(base+'/projects/'+b.id+'/work');await page.locator('[data-work-project]').first().waitFor();await page.locator('#crSpacesTab[href="/projects"]').waitFor();await page.screenshot({path:'/tmp/project-integration-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert(await page.locator('#rcProjectPage').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.locator('#rcSpaceAddExisting').click();await page.locator('.rc-space-dialog input[value=work-conversation]').check();assert(await page.locator('.rc-space-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:'/tmp/project-integration-mobile.png'});await page.keyboard.press('Escape');
  const loggedOut=await browser.newContext(),login=await loggedOut.newPage();login.on('pageerror',e=>errors.push(e.message));await login.goto(base+workPath);await login.locator('#gateToken').fill(token);await login.locator('#gateTokenBtn').click();await login.locator('#chatTools').waitFor();assert.equal(new URL(login.url()).pathname,workPath);await loggedOut.close();
  assert.deepEqual(errors,[]);console.log('Project integration: whole/individual/reference membership, identity, repository selection, files, drafts, routes, settings, mobile and sign-in passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
