const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
    localStorage.setItem('x056_display_preferences', JSON.stringify({ open: 'side', maximize: 'modal' }));
    const Native = EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.fixtureStream = this;
      }
    };
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const headers = {
    Authorization: 'Bearer browser-fixture-token-0123456789',
    'Content-Type': 'application/json',
  };
  const api = async (path, body) => {
    const r = await context.request[body ? 'post' : 'get'](base + '/api/' + path, {
      headers,
      ...(body ? { data: body } : {}),
    });
    assert.ok(r.ok(), await r.text());
    return r.json();
  };
  const { projects } = await api('projects'),
    p = projects.find((p) => p.name === 'Website refresh'),
    sid = p.conversations.find((c) => c.title === 'Build the new homepage').sessionId;
  await page.goto(base);
  await page.locator('.cr-task').first().waitFor();
  await page.locator('#crSelectToggle').click();
  await page.locator('.bulk-checkbox').first().check();
  await page.locator('.bulk-checkbox').nth(1).check();
  await page.locator('[data-bulk=archive]').click();
  await page.waitForFunction(() => document.querySelector('#crBulkBar strong').textContent === '0 selected');
  await page.locator('[data-filter=archived]').click();
  assert.equal(await page.locator('.cr-task').count(), 2);
  await page.reload();
  await page.locator('[data-filter=archived]').click();
  await page.waitForFunction(() => document.querySelectorAll('.cr-task').length === 2);
  await page.locator('#crSelectToggle').click();
  await page.locator('#crBulkAll').click();
  await page.locator('[data-bulk=restore]').click();
  await page.waitForFunction(() => document.querySelectorAll('.cr-task').length === 0);
  await page.locator('[data-filter=all]').click();
  await page.locator('#crSelectToggle').click();
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  assert.equal(await page.locator('body').getAttribute('data-chat-mode'), 'side');
  await page.locator('#chatMax').click();
  assert.equal(await page.locator('body').getAttribute('data-chat-mode'), 'modal');
  await page.locator('#chatMax').click();
  assert.equal(await page.locator('body').getAttribute('data-chat-mode'), 'page');
  await page.locator('#chatMax').click();
  assert.equal(await page.locator('body').getAttribute('data-chat-mode'), 'modal');
  await page.evaluate(
    ({ pid, sid }) =>
      window.fixtureStream.dispatchEvent(
        new MessageEvent('assistant_text', {
          data: JSON.stringify({
            data: {
              projectId: pid,
              sessionId: sid,
              text: '| Priority | Feature | What it adds |\n|---|---|---|\n| First | Global search | Search messages across projects and jump to the matching conversation. |\n| Later | Queue planner | Plan messages for later. |',
            },
          }),
        }),
      ),
    { pid: p.id, sid },
  );
  const table = page.locator('.table-scroll').last();
  assert.equal(await table.locator('th').first().innerText(), 'Priority');
  const size = await table.locator('th').first().boundingBox();
  assert.ok(size.width > 65);
  await table.screenshot({ path: '/tmp/workspace-v3-table.png' });
  const image = '/tmp/workspace-v3-result.png';
  fs.writeFileSync(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9p8AAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const artifact = await api('workspace/artifacts', {
    projectId: p.id,
    sessionId: sid,
    path: image,
    title: 'Preview screenshot',
  });
  await api('workspace/artifacts', {
    projectId: p.id,
    sessionId: sid,
    url: 'https://preview.example.test',
    title: 'Live preview',
  });
  fs.unlinkSync(image);
  const saved = await context.request.get(base + '/api/workspace/artifact-file?id=' + artifact.id, {
    headers,
  });
  assert.ok(saved.ok());
  assert.match(saved.headers()['content-type'], /image\/png/);
  assert.ok((await saved.body()).length > 0);
  await page.locator('#chatResults').click();
  await page.locator('dialog[open] .artifact-card').first().waitFor();
  assert.equal(await page.locator('dialog[open] .artifact-card').count(), 2);
  await page.locator('dialog[open] [data-add]').click();
  await page.locator('dialog[open] select[name=kind]').selectOption('test');
  await page.locator('dialog[open] input[name=title]').fill('Browser tests');
  await page.locator('dialog[open] input[name=value]').fill('24 tests passed');
  await page.locator('dialog[open] form').getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('dialog[open] .artifact-card').length === 3);
  await page.locator('dialog[open] [data-view]').click();
  await page.locator('.artifact-large').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('#chatClose').click();
  await page
    .locator('.cr-task')
    .filter({ hasText: 'Review accessibility findings' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Conversation results', exact: true }).click();
  await page.locator('dialog[open] .cr-empty').waitFor();
  assert.equal(
    await page.locator('dialog[open] .artifact-card').count(),
    0,
    'Row menu reviews its own conversation',
  );
  await page.keyboard.press('Escape');
  await page.locator('#crArtifactsTab').click();
  await page.locator('#artifactItems .artifact-card').first().waitFor();
  assert.equal(await page.locator('#artifactItems .artifact-card').count(), 3);
  await page.locator('#artifactSearch').fill('Browser');
  assert.equal(await page.locator('#artifactItems .artifact-card').count(), 1);
  await page.locator('#artifactSearch').fill('');
  await page.screenshot({ path: '/tmp/workspace-v3-artifacts.png' });
  const queuedBody = {
    projectId: p.id,
    sessionId: sid,
    prompt: 'Planned first',
    paused: true,
    requestId: require('node:crypto').randomUUID(),
  };
  const one = await api('queue', queuedBody);
  assert.equal(
    (await api('queue', queuedBody)).id,
    one.id,
    'Retrying a queued request does not duplicate it',
  );
  await page.locator('#crPlannerTab').click();
  await page.locator('.planner-item').first().waitFor();
  await page.locator('#plannerAdd').click();
  await page.locator('dialog[open] select[name=conversation]').selectOption(p.id + '::' + sid);
  await page.locator('dialog[open] textarea').fill('Planned second');
  await page.locator('dialog[open] input[name=paused]').check();
  await page.locator('dialog[open]').getByRole('button', { name: 'Add to queue', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.planner-item').length === 2);
  const two = (await api('queue'))[p.id].find((x) => x.text === 'Planned second');
  await page.locator('.planner-item').last().getByRole('button', { name: 'Move up', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.planner-item').textContent.includes('Planned second'),
  );
  await page.locator('.planner-item').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('dialog[open] textarea').fill('Scheduled revision');
  await page.locator('dialog[open] input[type=datetime-local]').fill('2099-01-01T12:00');
  await page.locator('dialog[open]').getByRole('button', { name: 'Save changes' }).click();
  await page.waitForFunction(() =>
    document.querySelector('.planner-item').textContent.includes('Scheduled revision'),
  );
  const planned = await api('queue');
  assert.equal(planned[p.id][0].id, two.id);
  assert.ok(planned[p.id][0].notBefore > Date.now());
  await page.screenshot({ path: '/tmp/workspace-v3-queue.png' });
  await api('queue/remove', { projectId: p.id, id: one.id });
  await api('queue/remove', { projectId: p.id, id: two.id });
  assert.equal((await api('messages/status?requestId=' + queuedBody.requestId)).status, 'cancelled');
  await page.locator('#crBoardTab').click();
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  let request,
    attempts = 0;
  await page.route('**/api/sessions/current/messages', async (route) => {
    attempts++;
    request = route.request().postDataJSON();
    await route.fetch();
    await route.abort('failed');
  });
  await page.locator('#prompt').fill('Verify delivery with a dropped response');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() =>
    document.querySelector('#deliveryStrip').textContent.includes('not confirmed'),
  );
  const receipt = await api('messages/status?requestId=' + request.requestId);
  assert.equal(receipt.status, 'accepted');
  await page.locator('#deliveryStrip button').click();
  await page.locator('.delivery-item').getByRole('button', { name: 'Check delivery' }).click();
  await page.waitForFunction(
    () => document.querySelector('.delivery-item strong').textContent === 'Accepted',
  );
  assert.equal(attempts, 1);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  await page.waitForFunction(() => document.querySelector('#deliveryStrip').textContent.includes('Accepted'));
  assert.equal(attempts, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const close = await page.locator('#chatClose').boundingBox();
  assert.ok(close.x >= 0 && close.x + close.width <= 390);
  await page.screenshot({ path: '/tmp/workspace-v3-mobile.png' });
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    'PASS: persistent bulk archive/restore, expansion cycle, readable tables, durable artifacts/results, queue ordering/scheduling, dropped-response recovery without duplicate send, and mobile fit.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
