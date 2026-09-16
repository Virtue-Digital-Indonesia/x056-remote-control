const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
    let agents=[{agentId:'review',agentType:'codex-subagent',description:'Check account sign-in',status:'running',startedAt:Date.now()-40000}];
    await page.route('**/api/conversations/subagents?**',r=>r.fulfill({json:{subagents:agents,self:null}}));
    await page.route('**/api/conversations/workflows?**',r=>r.fulfill({json:{runs:[]}}));
    await page.route('**/api/conversations/subagent-history?**',r=>r.fulfill({json:{rows:[{role:'assistant',text:'Checking the callback and inherited tools.'}],done:true,cursor:0}}));
    await page.goto(process.argv[2]||'http://127.0.0.1:8798');
    await page.locator('.cr-task').filter({hasText:'Update the component library'}).click();
    const island=page.locator('#wfIsland'),trigger=page.locator('#chatAgents');
    await island.locator('.wf-agent-row').waitFor();
    assert.equal(await page.locator('#wfTitle').textContent(),'Agents');
    assert.ok((await island.boundingBox()).height<180,'one agent must not open a dashboard-sized panel');
    assert.equal(await trigger.evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
    assert.ok((await trigger.boundingBox()).height<=32);
    async function fits(){
      const b=await page.evaluate(()=>{
        const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
        return {card:rect('#wfIsland'),chat:rect('.focus-main'),toolbar:rect('.topbar'),composer:rect('.composer-wrap')};
      });
      assert.ok(b.card.top>=b.toolbar.bottom+10,JSON.stringify(b));
      assert.ok(b.card.bottom<=b.composer.top-10,JSON.stringify(b));
      assert.ok(b.card.left>=b.chat.left+14&&b.card.right<=b.chat.right-14,JSON.stringify(b));
    }
    await fits();
    await page.screenshot({path:'/tmp/agents-floating-dark.png'});
    await trigger.click();assert.ok(await island.isHidden());
    await trigger.click();await island.waitFor();
    await island.locator('[data-agent=review]').click();
    await page.locator('.agent-reader-scroll').filter({hasText:'Checking the callback'}).waitFor();
    await page.keyboard.press('Escape');assert.ok(await island.isVisible());
    await page.keyboard.press('Escape');assert.ok(await island.isHidden());
    assert.ok(await trigger.evaluate(e=>e===document.activeElement));
    await trigger.click();await page.locator('#prompt').click();assert.ok(await island.isHidden());
    await page.waitForTimeout(5500);assert.ok(await island.isHidden(),'polling must respect dismissal');
    agents=Array.from({length:16},(_,i)=>({agentId:'a'+i,agentType:'codex-subagent',description:i===0?'Review <img src=x onerror=alert(1)>':'Review implementation area '+(i+1),status:i<9?'running':'done'}));
    await trigger.click();
    await page.waitForFunction(()=>document.querySelectorAll('.wf-agent-row').length===6);
    assert.equal(await island.locator('img').count(),0);
    assert.equal(await trigger.locator('small').textContent(),'9');
    assert.equal(await island.locator('.wf-agent-row').filter({hasText:'Finished'}).count(),0);
    assert.equal(await island.locator('.wf-agents-more').textContent(),'Show 3 more agents');
    await island.locator('.wf-agents-more').click();
    assert.equal(await island.locator('.wf-agent-row').count(),9);await fits();
    assert.ok(await page.locator('#wfBody').evaluate(e=>e.scrollHeight>e.clientHeight));
    await page.emulateMedia({colorScheme:'light'});
    await page.screenshot({path:'/tmp/agents-floating-many-light.png'});
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await fits();
    assert.ok(await island.evaluate(e=>e.scrollWidth<=e.clientWidth));
    await page.screenshot({path:'/tmp/agents-floating-mobile.png'});
    agents=agents.map((a,i)=>({...a,status:i===0?'unknown':i===1?'failed':i===2?'stopped':'done'}));
    await trigger.waitFor({state:'hidden'});
    assert.ok(await island.isHidden(),'last active agent finishing closes the popup');
    await page.locator('#chatActivity').click();
    await page.getByRole('menuitem',{name:'Usage & subagents'}).click();
    await page.locator('#subList [data-agent]').first().waitFor();
    assert.equal(await page.locator('#subList [data-agent]').count(),16,'full history remains in Activity');
    await page.keyboard.press('Escape');
    await page.locator('#chatClose').click();assert.ok(await island.isHidden());
    assert.deepEqual(errors,[]);
    console.log('PASS: compact agent popup, live ordering, transcripts, dismissal, expansion, themes and responsive bounds');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
