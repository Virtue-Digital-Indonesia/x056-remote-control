// Run fixture.ts first, then: node test/browser/mcp-oauth.cjs [base URL]
// The MCP servers list shows an OAuth line for an http server that supports
// it: Not signed in -> Sign in (opens the authorize URL in a new tab, then
// polls until signed in) -> "Signed in · renews automatically" -> Sign out;
// a refused refresh shows "Sign in again". The gateway side is unit tested
// (test/mcp-oauth.test.ts); here the API is routed. SHOTS=<dir> writes
// screenshots of the row in each state, dark and light, desktop and phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8799';
const shots = process.env.SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });

const EXPIRES = Date.UTC(2026, 9, 6, 6, 5);
function servers(state) {
  const oauth = state === 'signed-in' ? { supported: true, signedIn: true, expiresAt: EXPIRES, lastRefreshAt: EXPIRES - 7200e3, error: null }
    : state === 'expired' ? { supported: true, signedIn: false, expiresAt: EXPIRES, lastRefreshAt: null, error: 'signin_required' }
    : { supported: true, signedIn: false, expiresAt: null, lastRefreshAt: null, error: null };
  const carbon = { name: 'carbon-mcp', transport: 'http', url: 'https://mcp.carbondesignsystem.com/mcp', headers: state === 'signed-in' ? { Authorization: '«redacted-abcd»' } : {}, accountCount: 3, totalAccounts: 3, synced: true, differing: [] };
  return {
    accounts: { claude: 3, codex: 3 },
    servers: [
      { ...carbon, provider: 'claude', oauth },
      { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], provider: 'claude', accountCount: 3, totalAccounts: 3, synced: true, differing: [] },
      { name: 'midtrans-docs', transport: 'http', url: 'https://docs.example/mcp', provider: 'claude', accountCount: 3, totalAccounts: 3, synced: true, differing: [], oauth: { supported: false, signedIn: false, expiresAt: null, lastRefreshAt: null, error: null } },
      { name: 'Obscura', transport: 'http', url: 'https://dms.example/mcp', headers: { Authorization: '«redacted-wxyz»' }, provider: 'claude', accountCount: 3, totalAccounts: 3, synced: true, differing: [], oauth: { supported: true, signedIn: false, expiresAt: null, lastRefreshAt: null, error: null } },
      { ...carbon, provider: 'codex', oauth },
    ],
  };
}

async function boot(browser, { width = 1440, height = 1000, theme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Jakarta' });
  await context.addInitScript((theme) => {
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
    localStorage.setItem('x056_theme', theme);
  }, theme);
  const sim = { state: 'none', calls: [] };
  await context.route('**/api/mcp/servers', (route) => route.fulfill({ json: servers(sim.state) }));
  await context.route('**/api/mcp/oauth/**', async (route) => {
    const u = new URL(route.request().url());
    sim.calls.push(u.pathname + (route.request().postData() ? ' ' + route.request().postData() : ''));
    if (u.pathname.endsWith('/start')) return route.fulfill({ json: { authorizeUrl: base + '/healthz?authorize=fake' } });
    if (u.pathname.endsWith('/status')) return route.fulfill({ json: servers(sim.state).servers[0].oauth });
    if (u.pathname.endsWith('/signout')) { sim.state = 'none'; return route.fulfill({ json: { ok: true, accounts: [] } }); }
    return route.fallback();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors, sim };
}

async function shot(page, name) {
  if (!shots) return;
  await page.locator('#mcpSrvList').screenshot({ path: `${shots}/${name}.png` });
}

(async () => {
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const theme of ['dark', 'light']) {
      for (const [width, height, tag] of [[1440, 1000, 'desktop'], [390, 844, 'phone']]) {
        const { context, page, errors, sim } = await boot(browser, { width, height, theme });
        // The callback page's "Back to x056" link opens the list by itself.
        await page.goto(base + '/?mcp=servers');
        const line = page.locator('#mcpSrvList .mcp-item').first().locator('.mi-auth');
        await line.waitFor({ timeout: 15000 });
        assert.equal(new URL(page.url()).search, '', 'the ?mcp=servers parameter is dropped');
        // Only the http server that supports OAuth gets a line (both providers' rows).
        assert.equal(await page.locator('#mcpSrvList .mi-auth').count(), 3);
        assert.match(await line.innerText(), /Not signed in/);
        // A server that already works with its own key is not called "not signed in".
        const keyed = page.locator('#mcpSrvList .mi-auth[data-oauth="Obscura"]');
        assert.match(await keyed.innerText(), /Uses its own Authorization header/);
        assert.equal(await keyed.locator('.mcp-signin.primary').count(), 0);
        await shot(page, `${theme}-${tag}-not-signed-in`);

        // Sign in opens the authorize URL in a NEW tab, opened inside the click.
        const popupP = context.waitForEvent('page');
        await line.locator('.mcp-signin').click();
        const popup = await popupP;
        await popup.waitForURL(/authorize=fake/);
        assert.ok(sim.calls.some((c) => c.includes('/start') && c.includes('carbon-mcp')));
        await page.locator('#mcpSrvList .mcp-signin', { hasText: 'Waiting for sign-in' }).first().waitFor();
        await shot(page, `${theme}-${tag}-waiting`);
        // The gateway reports signed in: the panel notices by polling.
        sim.state = 'signed-in';
        await popup.close();
        await page.locator('#mcpSrvList .mi-auth.ok').first().waitFor({ timeout: 8000 });
        assert.match(await line.innerText(), /Signed in · renews automatically · token valid until 13:05/);
        assert.equal(await page.locator('#mcpSrvList .mi-auth[data-oauth="carbon-mcp"] .mcp-signin').count(), 0);
        assert.match(await page.locator('#mcpSrvStatus').innerText(), /Signed in to carbon-mcp/);
        await shot(page, `${theme}-${tag}-signed-in`);

        // A refused refresh: amber, "Sign in again".
        sim.state = 'expired';
        await page.evaluate(() => document.getElementById('mcpSrvBtn').click());
        await page.locator('#mcpSrvList .mi-auth.warn').first().waitFor();
        assert.match(await line.innerText(), /Sign-in expired/);
        assert.equal(await line.locator('.mcp-signin').innerText(), 'Sign in again');
        await shot(page, `${theme}-${tag}-sign-in-again`);

        // Sign out asks first, then calls the API and re-renders.
        await line.locator('.mcp-signout').click();
        await page.locator('.modal-actions .send.danger', { hasText: 'Sign out' }).click();
        await page.locator('#mcpSrvList .mi-auth', { hasText: 'Not signed in' }).first().waitFor();
        assert.ok(sim.calls.some((c) => c.includes('/signout') && c.includes('carbon-mcp')));
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
    console.log('mcp-oauth browser checks passed');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
