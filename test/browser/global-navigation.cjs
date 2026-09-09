const assert = require('node:assert/strict');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8780';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);await page.waitForSelector('.cr-task');

  await page.locator('.cr-project-link').filter({ hasText: 'Website refresh' }).click();
  assert.equal(await page.locator('#crScopeTitle').innerText(), 'Website refresh');
  await page.locator('#crAccountsTab').click();
  await page.keyboard.press('Control+K');
  await page.locator('.palette .m-in').waitFor();
  await page.locator('.palette .m-in').fill('Compare deployment options');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('conversationSurface').hidden);
  assert.match(await page.locator('#projTitle').innerText(), /Compare deployment options/);
  await page.locator('#chatClose').click();

  await page.locator('.cr-project-link').filter({ hasText: 'Website refresh' }).click();
  await page.locator('#crAccountsTab').click();
  await page.locator('#crBoardTab').click();
  assert.equal(await page.locator('#crScopeTitle').innerText(), 'All projects');
  assert.equal(await page.locator('#crProjectFilter').inputValue(), '');
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS global quick switch and Control room resets to All projects');
})().catch((error) => { console.error(error); process.exit(1); });
