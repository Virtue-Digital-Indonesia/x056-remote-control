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
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/projects/'+space.id+'/overview');
  const overviewNew=page.locator('[data-overview-new="work"]');await overviewNew.waitFor();assert(await overviewNew.isEnabled());
  await page.goto(base+'/projects/'+space.id+'/work');
  await page.locator('#rcSpaceNewConversation').click();
  let form=page.locator('dialog[open] form');await form.waitFor();
  await form.locator('[name="name"]').fill('My fresh workspace');
  assert.equal(await form.locator('[name="folder"]').inputValue(),'my-fresh-workspace');
  await form.locator('[name="folder"]').fill('browser-'+randomUUID());
  await form.locator('.cr-primary').click();
  await page.waitForURL(/\/work\/[^/]+\/[^/]+$/);await page.locator('#prompt').waitFor();
  const workUrl=page.url();await page.reload();await page.locator('#prompt').waitFor();assert.equal(page.url(),workUrl);
  await page.goto(base+'/projects/'+space.id+'/work');await page.locator('#rcSpaceAddWork').click();
  await page.locator('dialog[open] [data-existing]').click();await page.locator('dialog[open] [name="cwd"]').waitFor();await page.keyboard.press('Escape');
  await page.setViewportSize({width:375,height:812});await page.locator('#rcSpaceAddWork').click();await page.locator('dialog[open] [data-create]').click();
  await page.locator('dialog[open] [name="folder"]').waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/project-workspace-creation-mobile.png'});
  assert.deepEqual(errors,[]);console.log('Workspace creation: overview, empty Work, Git creation, navigation/refresh, existing option and mobile passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
