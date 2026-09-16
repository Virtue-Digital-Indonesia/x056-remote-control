const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(() => localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
    const page = await context.newPage(), errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    let polls=0, message='Checking the child implementation';
    await page.route('**/api/conversations/subagents?**', route=>{
      polls++;
      return route.fulfill({json:{subagents:[{agentId:'child',agentType:'codex-subagent',description:'Astra review agent',status:'running',bytes:1000}],self:null}});
    });
    await page.route('**/api/conversations/subagent-history?**', route=>route.fulfill({json:{rows:[{role:'assistant',text:message}],done:true,cursor:0}}));
    await page.goto(process.argv[2]||'http://127.0.0.1:8798');
    await page.locator('.cr-task').filter({hasText:'Build the new homepage'}).click();
    await page.locator('#chatAgents').waitFor();
    assert.match(await page.locator('#chatAgents').getAttribute('title'),/1 agent · 1 running/);
    await page.locator('#wfIsland .wf-agent-row').waitFor();
    // Child polling must continue with the parent's turn idle and reader closed.
    const before=polls;
    await page.waitForTimeout(5500);
    assert.ok(polls>before);
    await page.locator('#wfIsland [data-agent=child]').click();
    await page.locator('.agent-reader-scroll').filter({hasText:message}).waitFor();
    message='Latest child progress is visible';
    await page.locator('.agent-reader-scroll').filter({hasText:message}).waitFor({timeout:10000});
    assert.ok(!(await page.locator('#chat').innerText()).includes(message));
    assert.deepEqual(errors,[]);
    console.log('PASS: direct Agents entry, running count, idle-parent polling, separate live transcript');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
