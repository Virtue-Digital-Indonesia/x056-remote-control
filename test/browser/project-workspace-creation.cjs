const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8795';
const token = 'browser-fixture-token-0123456789';
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);
  const response=await context.request.post(base+'/api/project-spaces',{headers:{Authorization:'Bearer '+token},data:{requestId:randomUUID(),name:'New workspace browser',defaults:{work:{provider:'claude'}}}});
  assert.equal(response.status(),201);const space=await response.json();
  const unauthorized=await context.request.post(base+'/api/project-spaces/'+space.id+'/workspaces',{data:{requestId:randomUUID(),name:'Unauthorized',folder:'unauthorized'}});assert.equal(unauthorized.status(),401);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/projects/'+space.id+'/overview');
  const overviewNew=page.locator('[data-overview-new="work"]');await overviewNew.waitFor();assert(await overviewNew.isEnabled());
  await page.goto(base+'/projects/'+space.id+'/work');
  await page.locator('#rcSpaceNewConversation').click();
  let form=page.locator('dialog[open] form');await form.waitFor();
  await form.locator('[name="name"]').fill('My fresh workspace');
  assert.equal(await form.locator('[name="folder"]').inputValue(),'my-fresh-workspace');
  await form.locator('[name="folder"]').fill('browser-'+randomUUID());
  let release,createCount=0,failRefresh=false;
  const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/project-spaces/*/workspaces',async route=>{
    createCount++;await held;
    const response=await route.fetch();failRefresh=true;await route.fulfill({response});
  });
  await page.route('**/api/project-spaces',async route=>{
    if(failRefresh&&route.request().method()==='GET'){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Temporary refresh failure'})});}
    else await route.continue();
  });
  await form.locator('.cr-primary').click();
  assert(await form.locator('[name=folder]').isDisabled());
  await page.keyboard.press('Escape');assert(await form.isVisible());
  assert(await page.locator('dialog[open] header button').isDisabled());assert(await form.isVisible());
  release();
  await page.getByRole('button',{name:'Open created Work',exact:true}).waitFor();
  assert(await form.locator('[role=alert]').textContent());
  failRefresh=false;
  await page.getByRole('button',{name:'Open created Work',exact:true}).click();
  await page.waitForURL(/\/work\/[^/]+\/[^/]+$/);await page.locator('#prompt').waitFor();
  assert.equal(createCount,1);
  const workUrl=page.url();await page.reload();await page.locator('#prompt').waitFor();assert.equal(page.url(),workUrl);
  await page.goto(base+'/projects/'+space.id+'/work');await page.locator('#rcSpaceAddWork').click();
  await page.locator('dialog[open] [data-existing]').click();await page.locator('dialog[open] [name="cwd"]').waitFor();await page.keyboard.press('Escape');
  await page.setViewportSize({width:375,height:812});await page.locator('#rcSpaceAddWork').click();await page.locator('dialog[open] [data-create]').click();
  await page.locator('dialog[open] [name="folder"]').waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const width of [375,320]){
    await page.setViewportSize({width,height:640});
    const bounds=await page.locator('dialog[open]').boundingBox();
    assert(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y>=0&&bounds.y+bounds.height<=641);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.screenshot({path:'/tmp/project-workspace-creation-mobile.png'});
  await page.locator('dialog[open] [name=name]').fill('_ Leading name');
  assert.equal(await page.locator('dialog[open] [name=folder]').inputValue(),'leading-name');
  await page.keyboard.press('Escape');
  const current=await (await context.request.get(base+'/api/project-spaces',{headers:{Authorization:'Bearer '+token}})).json();
  const archived=await context.request.post(base+'/api/project-spaces/'+space.id+'/archive',{headers:{Authorization:'Bearer '+token},data:{expectedRevision:current.projects.find(p=>p.id===space.id).revision,expectedTopology:current.topology,archived:true,operationId:randomUUID()}});
  assert.equal(archived.status(),201);
  await page.reload();await page.locator('#rcSpaceAddWork').waitFor();assert(await page.locator('#rcSpaceAddWork').isDisabled());
  assert.deepEqual(errors,[]);console.log('Workspace creation: overview, empty Work, Git creation, navigation/refresh, existing option and mobile passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
