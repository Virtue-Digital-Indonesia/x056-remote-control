const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const reference = '/tmp/x056-local-reference.csv';
fs.writeFileSync(reference, 'id,status\n1,ok\n');

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1120, height: 900 } });
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/conversations/history-page*', async (route) => {
    const response = await route.fetch(), data = await response.json();
    data.rows.push({
      role: 'assistant',
      text: 'Review [Exact results](' + reference + ':2), [documentation](https://example.test/docs), and [unsafe](javascript:alert(1)).',
      ts: new Date().toISOString(),
    });
    await route.fulfill({ response, json: data });
  });
  await page.goto(base);
  await page.waitForSelector('.cr-task');
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  const ref = page.locator('.content .local-ref').filter({ hasText: 'Exact results' });
  await ref.waitFor();
  assert.equal(await ref.getAttribute('title'), reference + ':2');
  assert.equal(await page.locator('.content a[href="https://example.test/docs"]').count(), 1);
  assert.match(await page.locator('.msg.assistant').last().innerText(), /\[unsafe\]\(javascript:alert\(1\)\)/);
  await page.screenshot({ path: '/tmp/x056-local-references.png', animations: 'disabled' });

  const download = page.waitForEvent('download');
  await ref.click();
  assert.equal((await download).suggestedFilename(), 'x056-local-reference.csv');
  const projects = await (await context.request.get(base + '/api/projects', { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } })).json();
  const project = projects.projects.find((item) => item.name === 'Website refresh');
  const conversation = project.conversations.find((item) => item.title === 'Build the new homepage');
  const artifacts = await (await context.request.get(base + '/api/workspace/artifacts?projectId=' + encodeURIComponent(project.id) + '&sessionId=' + encodeURIComponent(conversation.sessionId), { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } })).json();
  assert.ok(artifacts.some((item) => item.original === reference && item.title === 'Exact results'));

  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await browser.close();
  fs.unlinkSync(reference);
  console.log('PASS local references render safely, download retained files and fit mobile');
})().catch((error) => { try { fs.unlinkSync(reference); } catch {} console.error(error); process.exit(1); });
