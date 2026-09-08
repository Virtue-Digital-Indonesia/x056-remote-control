const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8767',
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
  });
  const page = await ctx.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const headers = { Authorization: 'Bearer browser-fixture-token-0123456789' };
  const get = async (path) => (await ctx.request.get(base + '/api/' + path, { headers })).json();
  const post = async (path, data) => {
    const r = await ctx.request.post(base + '/api/' + path, { headers, data });
    assert.ok(r.ok(), await r.text());
    return r.json();
  };
  const { projects } = await get('projects'),
    p = projects.find((x) => x.name === 'Website refresh'),
    sid = p.conversations.find((x) => x.title === 'Build the new homepage').sessionId;
  const denied = await ctx.request.get(base + '/api/routing/preview?projectId=' + p.id + '&sessionId=' + sid);
  assert.equal(denied.status(), 401);
  await page.goto(base);
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  await page.locator('#moreBtn').click();
  await page.getByRole('menuitem', { name: 'Routing & accounts', exact: true }).click();
  let d = page.locator('dialog[open]').last();
  await d.locator('.route-decision').waitFor();
  assert.match(await d.innerText(), /Personal workspace/);
  await d.locator('select[name=lock]').selectOption('primary');
  await d.getByText('Priority work: allow', { exact: false }).click();
  await d.getByRole('button', { name: 'Save for next turn' }).click();
  await page.waitForTimeout(250);
  assert.equal(
    (await get('routing/preview?projectId=' + p.id + '&sessionId=' + sid)).preferences.lockedAccount,
    'primary',
  );
  await d.screenshot({ path: '/tmp/routing-v4-preview.png' });
  await d.getByRole('button', { name: 'History', exact: true }).click();
  await d.locator('.route-history').waitFor();
  assert.match(await d.innerText(), /routing preference/i);
  await page.keyboard.press('Escape');
  await page.locator('#sendAccountChip').click();
  d = page.locator('dialog[open]').last();
  assert.match(await d.innerText(), /this conversation/);
  await page.keyboard.press('Escape');
  await page.locator('#moreBtn').click();
  await page.getByRole('menuitem', { name: 'Continue with another provider', exact: true }).click();
  d = page.locator('dialog[open]').last();
  await d.locator('textarea[name=context]').waitFor();
  assert.match(await d.locator('textarea[name=context]').inputValue(), /Recent source messages/);
  assert.equal(await d.locator('[name=provider]').inputValue(), 'codex');
  assert.match(await d.locator('textarea[name=context]').inputValue(), /USER:|ASSISTANT:/);
  await d.screenshot({ path: '/tmp/routing-v4-handoff.png' });
  await page.keyboard.press('Escape');
  await page.locator('#chatClose').click();
  await page.locator('#crAccountsTab').click();
  await page.locator('#accountHealth').click();
  d = page.locator('dialog[open]').last();
  await d.locator('.health-card').first().waitFor();
  const card = d.locator('[data-account=primary]');
  await card.locator('[name=capacity]').fill('2');
  await card.locator('[name=reserve]').fill('20');
  await card.getByRole('button', { name: 'Save limits' }).click();
  await page.waitForTimeout(200);
  assert.match(await card.innerText(), /Limits saved/);
  const h = await get('accounts/health');
  assert.equal(h.find((x) => x.name === 'primary').maxConcurrent, 2);
  await d.screenshot({ path: '/tmp/routing-v4-health.png' });
  // Native dialogs dismiss outside and on Escape, with no horizontal overflow on mobile.
  await page.mouse.click(2, 2);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#accountHealth').click();
  d = page.locator('dialog[open]').last();
  await d.locator('.health-card').first().waitFor();
  const dims = await d.evaluate((e) => ({ w: e.clientWidth, scroll: e.scrollWidth }));
  assert.ok(dims.scroll <= dims.w + 2);
  await d.screenshot({ path: '/tmp/routing-v4-health-mobile.png' });
  await page.keyboard.press('Escape');
  await post('accounts/capacity', { name: 'primary', maxConcurrent: 0, reservePercent: 0 });
  await post('routing/conversation', {
    projectId: p.id,
    sessionId: sid,
    lockedAccount: null,
    useReserve: false,
  });
  assert.deepEqual(errors, []);
  console.log('Routing v4 browser checks passed');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
