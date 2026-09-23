const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8795';
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
    const headers={Authorization:'Bearer browser-fixture-token-0123456789'};
    const projects=await(await context.request.get(base+'/api/projects',{headers})).json();
    const project=projects.projects.find(p=>p.name==='Website refresh');
    const conversation=project.conversations.find(c=>c.title==='Build the new homepage');
    const saved=await context.request.post(base+'/api/conversations/preferences',{headers,data:{projectId:project.id,sessionId:conversation.sessionId,model:'claude-opus-5',effort:'medium'}});
    assert.equal(saved.status(),200);
    const after=await(await context.request.get(base+'/api/projects',{headers})).json();
    assert.equal(after.projects.find(p=>p.id===project.id).conversations.find(c=>c.sessionId===conversation.sessionId).model,'opus');
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/work/'+project.id+'/'+conversation.sessionId);
    await page.locator('#model').waitFor();
    await page.waitForFunction(()=>document.querySelector('#model')?.value==='opus');
    assert.equal((await page.locator('#model option[value="opus"]').textContent()).trim(),'Opus 5.5');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#model')?.value==='opus');
    assert.deepEqual(errors,[]);
    console.log('PASS old Opus pin saves as current alias, selector labels Opus 5.5, and direct-link refresh keeps it');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
