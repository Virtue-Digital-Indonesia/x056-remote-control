const assert = require('node:assert/strict');
let playwright; try { playwright=require('playwright'); } catch { playwright=require('/usr/local/lib/node_modules/playwright'); }
const { chromium } = playwright;
const base = process.argv[2] || 'http://127.0.0.1:8768';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#crAccountsTab').click();
    await page.waitForSelector('.cr-account-row');
    const providers = await page.locator('.cr-account-row .cr-account-avatar').evaluateAll(rows =>
      rows.map(row => row.classList.contains('codex') ? 'codex' : 'claude')
    );
    assert.deepEqual(providers, ['codex', 'claude', 'claude']);
    assert.deepEqual(errors, []);
    console.log('PASS: connected accounts are grouped by provider');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
