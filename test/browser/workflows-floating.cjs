const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8795';

(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.setItem('x056_token','browser-fixture-token-0123456789');
      localStorage.setItem('x056_display_preferences',JSON.stringify({open:'max',maximize:'modal'}));
    });
    const run = {runId:'audit',name:'cutover-audit-sweep',description:'Verify the cutover and review deployment health.',phases:[{title:'Audit'},{title:'Verify'}],started:12,finished:2,updatedAt:Date.now()};
    const old = {...run,runId:'older',name:'Earlier review',finished:12,updatedAt:Date.now()-3600000};
    let many=false;
    await page.route('**/api/conversations/workflows?**', route=>{
      const id = new URL(route.request().url()).searchParams.get('runId');
      return route.fulfill({json:{runs:id?[run]:many?Array.from({length:14},(_,i)=>({...run,runId:'audit-'+i,name:'Deployment review '+(i+1)})):[run,old],agents:id?Array.from({length:12},(_,i)=>({agentId:'agent-'+i,brief:'Review deployment check '+(i+1),done:i<2})):undefined}});
    });
    await page.route('**/api/conversations/workflow-history?**',route=>route.fulfill({json:{rows:[{role:'assistant',text:'All checks passed.'}],done:true,cursor:0}}));
    await page.goto(base);
    await page.locator('.cr-task').filter({hasText:'Build the new homepage'}).click();
    const island=page.locator('#wfIsland'); await island.waitFor();
    async function fits() {
      await page.waitForTimeout(150);
      const bounds=await page.evaluate(()=>{
        const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width};};
        return {card:rect('#wfIsland'),chat:rect('.focus-main'),toolbar:rect('.focus-main>.topbar'),composer:rect('.composer-wrap')};
      });
      assert.ok(bounds.card.top>=bounds.toolbar.bottom+10,JSON.stringify(bounds));
      assert.ok(bounds.card.bottom<=bounds.composer.top-10,JSON.stringify(bounds));
      assert.ok(bounds.card.right<=bounds.chat.right-14,JSON.stringify(bounds));
      assert.ok(bounds.card.left>=bounds.chat.left+14,JSON.stringify(bounds));
      assert.ok(bounds.card.width<=321,JSON.stringify(bounds));
    }
    await fits(); assert.ok((await island.boundingBox()).height<250);
    assert.equal(await island.locator('.wf-ph').count(),0);
    await page.screenshot({path:'/tmp/workflows-floating-dark.png'});
    const toggle=island.locator('.wf-top').first(); await toggle.focus(); await page.keyboard.press('Enter');
    await island.locator('.wf-ag').first().waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    await fits();
    await island.locator('.wf-ag').first().click();
    await page.locator('.agent-reader').waitFor();
    await page.keyboard.press('Escape'); assert.ok(await island.isVisible());
    await page.keyboard.press('Escape'); assert.ok(await island.isHidden());
    assert.equal(await page.locator('body').getAttribute('data-chat-mode'),'modal');
    async function reopen() {await page.locator('#chatActivity').click();await page.getByRole('menuitem',{name:'Workflow runs'}).click();await island.waitFor();}
    await reopen(); await page.locator('#prompt').click(); assert.ok(await island.isHidden());
    await reopen();
    await page.locator('#chatMax').click(); await reopen(); await fits();
    await page.emulateMedia({colorScheme:'light'});
    await page.screenshot({path:'/tmp/workflows-floating-light.png'});
    // A long list scrolls inside the card; the composer stays usable.
    await toggle.click(); many=true;
    await page.locator('#wfCloseBtn').click(); await reopen();
    await page.waitForFunction(()=>document.querySelectorAll('.wf-run').length===14);
    await fits();
    assert.ok(await page.locator('#wfBody').evaluate(e=>e.scrollHeight>e.clientHeight));
    await page.screenshot({path:'/tmp/workflows-floating-many.png'});
    await page.setViewportSize({width:390,height:844}); await fits();
    assert.ok(await island.evaluate(e=>e.scrollWidth<=e.clientWidth));
    await page.screenshot({path:'/tmp/workflows-floating-mobile.png'});
    await page.locator('#chatClose').click(); assert.ok(await island.isHidden());
    assert.deepEqual(errors,[]);
    console.log('PASS: compact workflow card, conversation bounds, scrolling, agent reader, outside/Escape dismissal, mobile and themes.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
