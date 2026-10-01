// A Codex child agent shows in the docked agent tree, keeps polling while the
// parent turn is idle, and its own live transcript stays out of the chat.
const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(() => localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
    const page = await context.newPage(), errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    let polls=0, histories=0, message='Checking the child implementation';
    await page.route('**/api/conversations/subagents?**', route=>{
      polls++;
      return route.fulfill({json:{subagents:[{agentId:'child',agentType:'codex-subagent',description:'Astra review agent',status:'running',startedAt:Date.now()-20000,bytes:1000}],self:null}});
    });
    await page.route('**/api/conversations/subagent-history?**', route=>{histories++;return route.fulfill({json:{rows:[{role:'assistant',text:message}],done:true,cursor:0}});});
    await page.goto(process.argv[2]||'http://127.0.0.1:8798');
    await page.locator('.cr-task').filter({hasText:'Build the new homepage'}).click();
    await page.locator('#chatAgentTree').click();
    const child = page.locator('#agentPane .ap-row[data-key="sub:child"]');
    await child.waitFor();
    assert.match(await child.textContent(), /Codex agent.*Astra review agent/);
    assert.equal(await child.locator('.ap-st').first().getAttribute('data-status'), 'run');
    assert.equal(await page.locator('#agentPaneLive').textContent(), 'Live');
    // Child polling continues with the parent's turn idle and no reader open.
    const before=polls;
    await page.waitForTimeout(5500);
    assert.ok(polls>before, 'the running child keeps the list polling');
    // Its history opens beside the tree and follows the live transcript.
    await child.click();
    await page.locator('#agentPaneHistBody').filter({hasText:message}).waitFor();
    message='Latest child progress is visible';
    await page.locator('#agentPaneHistBody').filter({hasText:message}).waitFor({timeout:10000});
    assert.ok(histories>=2);
    assert.ok(!(await page.locator('#chat').innerText()).includes(message));
    assert.deepEqual(errors,[]);
    console.log('PASS: Codex child in the agent tree, running status, idle-parent polling, separate live transcript');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
