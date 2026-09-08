const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource {
      constructor(...args) { super(...args); window.fixtureStream = this; }
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const headers = { Authorization: 'Bearer browser-fixture-token-0123456789' };
  const { projects } = await (await context.request.get(base + '/api/projects', { headers })).json();
  const p = projects.find(p => p.name === 'Website refresh');
  const sid = p.conversations.find(c => c.title === 'Build the new homepage').sessionId;
  await page.goto(base);
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  await page.waitForFunction(() => window.fixtureStream);
  await page.evaluate(({ pid, sid }) => window.fixtureStream.dispatchEvent(new MessageEvent('turn_orphaned', { data: JSON.stringify({ data: { projectId: pid, sessionId: sid, prompt: 'Question pane looks bad if not many questions [The user attached a long image filename for reference]' } }) })), { pid: p.id, sid });
  const card = page.locator('.orphan'), button = card.getByRole('button', { name: 'Resume', exact: true });
  await card.waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(300);
    const sizes = await button.evaluate(el => {
      const b = el.getBoundingClientRect(), c = el.closest('.orphan').getBoundingClientRect();
      return { buttonWidth: b.width, overflows: el.scrollWidth > el.clientWidth, contained: b.left >= c.left && b.right <= c.right && b.bottom <= c.bottom };
    });
    assert.ok(sizes.buttonWidth >= 84 && !sizes.overflows && sizes.contained);
    await card.screenshot({ path: '/tmp/resume-card-' + width + '.png' });
  }
  let mode = 'busy', request, attempts = 0, accept;
  await page.route('**/api/sessions/current/messages', async route => {
    attempts++; request = route.request().postDataJSON();
    if (mode === 'offline') return route.abort('failed');
    if (mode === 'busy') return route.fulfill({ status: 409, json: { message: 'busy' } });
    if (mode === 'error') return route.fulfill({ status: 503, json: { message: 'Account is temporarily unavailable.' } });
    await new Promise(resolve => { accept = resolve; });
    return route.fulfill({ json: { sessionId: sid } });
  });
  await button.click(); await card.getByRole('alert').waitFor();
  assert.equal(request.projectId, p.id); assert.equal(request.sessionId, sid);
  assert.match(request.prompt, /Continue from where you left off/);
  assert.match(await card.getByRole('alert').innerText(), /already running in this conversation/);
  assert.ok(await button.isEnabled());
  mode = 'error'; await button.click();
  await page.waitForFunction(() => document.querySelector('.orphan-error')?.textContent.includes('Account is temporarily unavailable'));
  assert.ok(await button.isEnabled());
  mode = 'offline'; await button.click();
  await page.waitForFunction(() => document.querySelector('.orphan-error')?.textContent.includes('Failed to fetch'));
  assert.ok(await button.isEnabled());
  mode = 'success'; await button.click();
  await page.waitForFunction(() => document.querySelector('.orphan')?.getAttribute('aria-busy') === 'true');
  assert.ok(await card.getByRole('button', { name: 'Resuming…' }).isDisabled());
  assert.equal(await card.getByRole('alert').count(), 0);
  while (!accept) await page.waitForTimeout(20);
  accept(); await card.waitFor({ state: 'detached' });
  assert.equal(attempts, 4); assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS: Resume fits desktop/mobile, targets the interrupted session, preserves retries on conflict/server/network errors, and removes the card only after acceptance.');
})().catch(e => { console.error(e); process.exit(1); });
