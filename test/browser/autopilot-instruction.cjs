const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8869';
const token = 'browser-fixture-token-0123456789';
const remembered = 'Follow docs/plan.md\nTick off each item as you finish it';
const edited = remembered + '\nRun the required checks and record the results before moving to the next item.';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const headers = { Authorization: 'Bearer ' + token };
      const api = async (path, data) => {
        const r = await context.request[data === undefined ? 'get' : 'post'](base + '/api/' + path, { headers, ...(data === undefined ? {} : { data }) });
        assert(r.ok(), await r.text()); return r.json();
      };
      const project = (await api('projects')).projects.find(p => p.name === 'Website refresh');
      const conversation = project.conversations.find(c => c.title === 'Review accessibility findings');
      const identity = { projectId: project.id, sessionId: conversation.sessionId };
      await api('autopilot', { ...identity, count: 13, instruction: remembered });
      await api('autopilot/stop', { sessionId: conversation.sessionId });
      await context.addInitScript(t => {
        localStorage.setItem('x056_token', t);
        localStorage.setItem('x056_display_preferences', JSON.stringify({ open: 'side', maximize: 'modal' }));
      }, token);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base);
      await page.locator('.cr-task').filter({ hasText: conversation.title }).first().click();
      await page.waitForFunction(() => !document.getElementById('helperBtn').disabled);
      const enable = async () => {
        await page.waitForTimeout(600); // let restored history finish scrolling before opening a menu
        await page.locator('#moreBtn').click();
        await page.getByRole('menuitem', { name: 'Autopilot', exact: true }).click();
        await page.getByRole('dialog', { name: 'Enable autopilot' }).waitFor();
      };
      await enable();
      assert.equal(await page.locator('#autopilotCount').inputValue(), '13');
      assert.equal(await page.locator('#autopilotInstruction').inputValue(), remembered);
      assert.equal(await page.locator('#autopilotInstruction').getAttribute('placeholder'), 'e.g. Follow docs/plan.md and tick off each item as you finish it');
      assert.equal(await page.locator('#autopilotInstruction').getAttribute('maxlength'), '4000');
      await page.locator('#autopilotCount').fill('6');
      await page.screenshot({ path: '/tmp/autopilot-enable-' + viewport.width + '.png' });
      await page.getByRole('dialog').getByRole('button', { name: 'Enable', exact: true }).click();
      await page.locator('#autopilotBar .ap-instruction').waitFor();
      assert.equal(await page.locator('#autopilotBar .ap-instruction').getAttribute('title'), remembered);
      await page.locator('#autopilotBar').getByRole('button', { name: 'Edit', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Standing instruction', exact: true });
      await dialog.locator('textarea').fill(edited);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(text => document.querySelector('#autopilotBar .ap-instruction')?.title === text, edited);
      assert.deepEqual((await api('autopilot'))[conversation.sessionId], { projectId: project.id, remaining: 6, count: 6, instruction: edited });
      const line = page.locator('#autopilotBar .ap-instruction');
      assert.equal(await line.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
      await line.click();
      assert.equal(await page.getByRole('dialog').locator('textarea').inputValue(), edited, 'tap shows the complete instruction');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await page.screenshot({ path: '/tmp/autopilot-bar-' + viewport.width + '.png' });
      await page.locator('#chatClose').click();
      if (viewport.width <= 850) await page.locator('#crProjects').click();
      await page.locator('#crAutomationsTab').click();
      const row = page.locator('.automation-ap-row').filter({ hasText: conversation.title });
      await row.locator('.automation-ap-instruction').waitFor();
      assert.equal(await row.locator('.automation-ap-instruction').getAttribute('title'), edited);
      assert.match(await row.innerText(), /Follow docs\/plan.md/);
      await row.locator('.automation-ap-open').click();
      await page.locator('#autopilotBar').waitFor({ state: 'visible' });
      // A real fixture turn triggers an actual autopilot continuation, carrying the instruction.
      const digestCount = await page.locator('.autopilot-digest').count();
      await api('sessions/current/messages', { ...identity, prompt: 'Check standing instruction rendering', interactive: false });
      const digest = page.locator('.autopilot-digest').last();
      await page.waitForFunction(n => document.querySelectorAll('.autopilot-digest').length > n, digestCount, { timeout: 20000 });
      await api('autopilot/stop', { sessionId: conversation.sessionId });
      assert.match(await digest.locator('summary').innerText(), /Continue task.*Follow docs\/plan.md/);
      assert.equal(await digest.getAttribute('open'), null);
      await digest.locator('summary').click();
      assert.match(await digest.innerText(), /Standing instruction from the user:\nFollow docs\/plan.md/);
      assert.match(await digest.innerText(), /AUTOPILOT_DONE/);
      await page.waitForTimeout(1600); // fixture CLI completes the in-flight step
      await page.reload();
      await page.locator('.cr-task').filter({ hasText: conversation.title }).first().click();
      await page.locator('.autopilot-digest').last().waitFor();
      assert.match(await page.locator('.autopilot-digest').last().locator('summary').innerText(), /Follow docs\/plan.md/);
      await enable();
      assert.equal(await page.locator('#autopilotCount').inputValue(), '6');
      assert.equal(await page.locator('#autopilotInstruction').inputValue(), edited);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Autopilot instruction: desktop/mobile prefill, edit, live state, Automations, tap and history PASS');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
