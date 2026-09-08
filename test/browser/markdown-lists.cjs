const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource { constructor(...args) { super(...args); window.fixtureStream = this; } };
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const { projects } = await (await context.request.get(base + '/api/projects', { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } })).json();
  const p = projects.find(p => p.name === 'Website refresh'), sid = p.conversations.find(c => c.title === 'Build the new homepage').sessionId;
  await page.goto(base); await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  await page.locator('.msg.assistant').first().waitFor();
  async function render(text) {
    await page.evaluate(({ pid, sid, text }) => window.fixtureStream.dispatchEvent(new MessageEvent('assistant_text', { data: JSON.stringify({ data: { projectId: pid, sessionId: sid, text } }) })), { pid: p.id, sid, text });
    return page.locator('.msg.assistant .content').last();
  }
  let content = await render('Deployment recommendations\n\n1. Compress assets.\n\n2. Improve the mobile layout.\n\n3. Make actions visible.\n\n4. Improve folder loading.\n\n5. Render PDFs progressively.');
  assert.equal(await content.locator(':scope > ol').count(), 1);
  assert.equal(await content.locator(':scope > ol > li').count(), 5);
  await content.screenshot({ path: '/tmp/assistant-numbered-list.png' });
  content = await render('3. Third\n\n4. Fourth\n\nA separate paragraph.\n\n8. Eighth');
  assert.deepEqual(await content.locator(':scope > ol').evaluateAll(lists => lists.map(l => l.start)), [3, 8]);
  content = await render('1. First\n\n1. Second\n\n   - Nested bullet\n   - Another nested bullet\n\n2. Third\n\n   Extra detail for the third item.');
  assert.equal(await content.locator(':scope > ol > li').count(), 3);
  assert.equal(await content.locator(':scope > ol > li:nth-child(2) > ul > li').count(), 2);
  assert.match(await content.locator(':scope > ol > li:nth-child(3) > p').innerText(), /Extra detail/);
  content = await render('+ Bullet one\n\n+ Bullet two\n\n## Separate heading\n\n1. Fresh list\n\n```text\n1. Literal\n\n2. Literal\n```');
  assert.equal(await content.locator(':scope > ul > li').count(), 2);
  assert.equal(await content.locator(':scope > ol > li').count(), 1);
  assert.match(await content.locator('pre code').innerText(), /1\. Literal\n\n2\. Literal/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); await browser.close();
  console.log('PASS: loose ordered lists, explicit starts, repeated Markdown numbering, nested lists, continuation paragraphs, mixed blocks and literal code.');
})().catch(e => { console.error(e); process.exit(1); });
