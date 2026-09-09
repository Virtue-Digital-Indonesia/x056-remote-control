// Start fixture.ts with X056_TEST_MANY=1 and the staged control-room assets.
const assert = require('node:assert/strict');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8776';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(), data = await response.json();
    const now = Date.now(), stale = now - 90 * 86400000;
    for (const project of data.projects) for (const conversation of project.conversations || []) {
      const fresh = /^Project (?:0[1-9]|1[0-5])/.test(project.name) && conversation.title.startsWith('Conversation 01');
      if (!conversation.lastMessageAt) conversation.createdAt = fresh ? now - 3600000 : stale;
    }
    await route.fulfill({ response, json: data });
  });

  await page.goto(base);
  await page.waitForSelector('.cr-task');
  const recentHeader = page.locator('.cr-conversation-group').filter({ hasText: 'Recent conversations' }).locator('header span');
  const recentCount = Number(await recentHeader.innerText());
  assert.ok(recentCount > 0 && recentCount <= 20, 'the default recent list is bounded');
  assert.match(await page.locator('#crRecentSettings').innerText(), /older conversations hidden/);
  await page.screenshot({ path: '/tmp/x056-recent-conversations.png', animations: 'disabled' });

  await page.locator('#crSearch').fill('Conversation 20');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cr-task').count(), 10, 'search finds stale conversations beyond the activity window');
  await page.locator('#crSearch').fill('');
  await page.locator('#crRecentSettings').click();
  assert.equal(await page.locator('#recentActivityWindow').inputValue(), '7');
  assert.equal(await page.locator('#recentMaximum').inputValue(), '20');
  await page.screenshot({ path: '/tmp/x056-recent-settings.png', animations: 'disabled' });
  await page.locator('#recentActivityWindow').selectOption('0');
  await page.locator('#recentMaximum').selectOption('50');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('displayPreferences').open);
  assert.equal(Number(await recentHeader.innerText()), 50);

  await page.reload();
  await page.waitForSelector('.cr-task');
  assert.equal(Number(await recentHeader.innerText()), 50, 'recent settings persist');
  await page.locator('#crSettings').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('displayPreferences').open);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS bounded recents, stale search, persistent settings and Escape dismissal');
})().catch((error) => { console.error(error); process.exit(1); });
