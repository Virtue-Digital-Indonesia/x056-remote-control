const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8795';
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const headers={Authorization:'Bearer browser-fixture-token-0123456789'};
    const {projects}=await(await context.request.get(base+'/api/projects',{headers})).json();
    const project=projects.find(p=>p.name==='Website refresh');
    const first=project.conversations.find(c=>c.title==='Build the new homepage');
    const second=project.conversations.find(c=>c.title==='Review accessibility findings');
    async function saved(model,effort){
      await page.waitForFunction(async({pid,sid,model,effort})=>{
        const data=await(await fetch('/api/projects',{headers:{Authorization:'Bearer '+localStorage.getItem('x056_token')}})).json();
        const c=data.projects.find(p=>p.id===pid).conversations.find(c=>c.sessionId===sid);
        return c.model===model&&c.effort===effort;
      },{pid:project.id,sid:first.sessionId,model,effort});
    }
    async function open(c){await page.locator('.cr-task[data-session="'+c.sessionId+'"]').click();await page.locator('#prompt').waitFor();}
    await page.goto(base);await open(first);
    await page.locator('#model').selectOption('fable');await page.locator('#effort').selectOption('high');
    await saved('fable','high');
    await page.locator('#chatClose').click();await open(second);
    await page.locator('#model').selectOption('opus');await page.locator('#effort').selectOption('low');
    await page.locator('#chatClose').click();await open(first);
    assert.equal(await page.locator('#model').inputValue(),'fable');
    assert.equal(await page.locator('#effort').inputValue(),'high');
    await page.reload();await open(first);
    assert.equal(await page.locator('#model').inputValue(),'fable');
    assert.equal(await page.locator('#effort').inputValue(),'high');
    const request=await context.request.post(base+'/api/conversations/send',{headers,data:{projectId:project.id,sessionId:first.sessionId,prompt:'Check saved model'}});
    const {approvalId}=await request.json();assert.ok(approvalId);
    const approvals=await(await context.request.get(base+'/api/mcp/approvals',{headers})).json();
    const approval=approvals.find(a=>a.id===approvalId);
    assert.equal(approval.model,'fable');assert.equal(approval.effort,'high');
    await context.request.post(base+'/api/mcp/approvals/decide',{headers,data:{id:approvalId,approve:false}});
    // Auto is an explicit choice, not a fallback to another chat or localStorage.
    await page.locator('#model').selectOption('');await page.locator('#effort').selectOption('');
    await saved('','');await page.reload();await open(first);
    assert.equal(await page.locator('#model').inputValue(),'');
    assert.equal(await page.locator('#effort').inputValue(),'');
    // Choices from another client update the picker too.
    await context.request.post(base+'/api/conversations/preferences',{headers,data:{projectId:project.id,sessionId:first.sessionId,model:'opus',effort:'high'}});
    await page.waitForFunction(()=>document.querySelector('#model').value==='opus'&&document.querySelector('#effort').value==='high');
    assert.deepEqual(errors,[]);
    console.log('PASS: selections saved before sending, sibling isolation, reload, Auto reset, MCP approval defaults and cross-client updates.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
