const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
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
    sid = p.conversations[0].sessionId;
  const previous = await api('memory/search?limit=200');
  if (previous.items.length)
    await api('memory/bulk', {
      items: previous.items.map(({ id, revision }) => ({ id, revision })),
      status: 'deleted',
    });
  for (const artifact of await api('workspace/artifacts'))
    await api('workspace/artifacts/remove', { id: artifact.id });
  const candidate = await api('memory/propose', {
    entry: {
      title: 'Browser review candidate',
      content: 'Use consistent spacing throughout the workspace.',
      projectId: p.id,
      kind: 'preference',
    },
  });
  await page.goto(base);
  await page.locator('#crMemoryTab').click();
  await page.locator('[data-memory-tab=inbox]').click();
  await page.locator('[data-memory-open="' + candidate.id + '"]').click();
  await page.locator('[data-edit]').click();
  await page.locator('.memory-editor [name=status]').selectOption('confirmed');
  await page
    .locator('.memory-editor [name=content]')
    .fill('Use consistent spacing and preserve compact conversation controls.');
  await page.locator('.memory-editor button.cr-primary').click();
  await page.waitForFunction(() => !document.querySelector('.memory-editor'));
  await page.locator('.memory-detail').filter({ hasText: 'Version history · 2' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-memory-tab=knowledge]').click();
  await page.locator('#memorySearch').fill('compact');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.memory-row').length === 1 &&
      document.querySelector('.memory-row').textContent.includes('Browser review candidate'),
  );
  assert.equal(await page.locator('.memory-row').count(), 1);
  await page.locator('[data-memory-select="' + candidate.id + '"]').check();
  await page.locator('[data-memory-bulk=archived]').click();
  await page.waitForFunction(() => document.querySelectorAll('.memory-row').length === 0);
  await page.locator('#memorySearch').fill('');
  await page.locator('#memoryFilters').click();
  await page.locator('#memoryStatus').selectOption('archived');
  await page.locator('[data-memory-open="' + candidate.id + '"]').click();
  await page.locator('[data-more]').click();
  await page.getByRole('menuitem', { name: 'Restore to review inbox' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-memory-tab=inbox]').click();
  await page.locator('[data-memory-select="' + candidate.id + '"]').check();
  await page.locator('[data-memory-bulk=confirmed]').click();
  await page.waitForFunction(() => !document.querySelector('[data-memory-select]:checked'));
  await page.locator('#memoryImport').click();
  await page.locator('dialog form [name=projectId]').selectOption(p.id);
  await page.getByRole('button', { name: 'Import sources', exact: true }).last().click();
  await page.locator('dialog [role=status]').filter({ hasText: 'new sources' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-memory-tab=sources]').click();
  await page.locator('[data-memory-source]').first().click();
  await page.getByRole('button', { name: 'Create memory', exact: true }).click();
  await page.locator('.memory-editor').waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('#crBoardTab').click();
  await page.locator('.cr-task').filter({ hasText: p.conversations[0].title }).first().click();
  await page.locator('#moreBtn').click();
  await page.getByRole('menuitem', { name: 'Conversation memory', exact: true }).click();
  await page.locator('[data-context-body]').filter({ hasText: 'Use memory here' }).waitFor();
  await page.locator('[data-enabled]').uncheck();
  await page.waitForFunction(() =>
    document.querySelector('[data-context-body]').textContent.includes('Retrieval is disabled'),
  );
  await page.locator('[data-enabled]').check();
  await page.keyboard.press('Escape');
  await page.locator('#moreBtn').click();
  await page.getByRole('menuitem', { name: 'Continue with another provider', exact: true }).click();
  await page.locator('[data-handoff-choices] [name=handoffMemory]').first().waitFor();
  await page.locator('[data-handoff-choices] [name=handoffMemory]').first().uncheck();
  await page.keyboard.press('Escape');
  await api('workspace/artifacts', {
    projectId: p.id,
    sessionId: sid,
    title: 'Memory preview',
    url: 'https://example.com/preview',
  });
  await api('workspace/artifacts', {
    projectId: p.id,
    sessionId: sid,
    title: 'Memory tests',
    summary: '21 focused tests passed',
    status: 'passed',
  });
  await page.locator('#chatResults').click();
  await page.locator('.results-dialog .artifact-card').first().waitFor();
  assert.equal(await page.locator('.results-dialog [data-source]').count(), 0);
  await page.locator('[data-result-kind=test]').click();
  assert.equal(await page.locator('.results-dialog .artifact-card').count(), 1);
  await page.screenshot({ path: '/tmp/memory-results.png' });
  await page.mouse.click(20, 400);
  await page.waitForFunction(() => !document.querySelector('.results-dialog'));
  await page.evaluate(
    ({ pid, sid }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('x056-delivery', 1);
        request.onsuccess = () => {
          const tx = request.result.transaction('messages', 'readwrite');
          tx.objectStore('messages').put({
            id: 'fixture-accepted',
            status: 'accepted',
            at: Date.now(),
            body: { projectId: pid, prompt: 'A delivered message' },
            sessionId: sid,
          });
          tx.oncomplete = resolve;
          tx.onerror = reject;
        };
      }),
    { pid: p.id, sid },
  );
  await page.reload();
  await page.locator('.cr-task').filter({ hasText: p.conversations[0].title }).first().click();
  await page.locator('#deliveryStrip button').waitFor();
  const footer = await page.locator('.composer-footer').boundingBox(),
    chip = await page.locator('#sendAccountChip').boundingBox(),
    delivery = await page.locator('#deliveryStrip').boundingBox();
  assert.ok(footer.height < 55);
  assert.ok(Math.abs(chip.y + chip.height / 2 - (delivery.y + delivery.height / 2)) < 10);
  await page.locator('#deliveryStrip button').click();
  assert.equal(await page.locator('.delivery-item').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Open conversation', exact: true }).count(), 0);
  await page.screenshot({ path: '/tmp/memory-delivery.png' });
  await page.keyboard.press('Escape');
  await page.locator('#chatClose').click();
  await page.locator('#currentVersion').click();
  await page.getByRole('heading', { name: 'Current version' }).waitFor();
  assert.ok(await page.locator('.release-state').textContent());
  await page.keyboard.press('Escape');
  await page.route('**/api/version', async (route) => {
    const data = await (await route.fetch()).json();
    data.ui.fingerprint = 'new-release';
    await route.fulfill({ json: data });
  });
  await page.locator('#currentVersion').click();
  await page.locator('.release-state').filter({ hasText: 'A newer release is running' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#crSettings').click();
  await page.locator('#stageMode [data-value=smart]').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('body').getAttribute('data-stage-mode'), 'smart');
  const unreadSid = p.conversations[1].sessionId;
  await page.locator('.cr-task[data-session="' + unreadSid + '"]').click({ button: 'right' });
  const markUnread = page.getByRole('menuitem', { name: 'Mark as unread', exact: true });
  if (await markUnread.count()) await markUnread.click();
  else await page.keyboard.press('Escape');
  await page.locator('#stageToggle').hover();
  await page.locator('.stage-conversation.unread[data-session="' + unreadSid + '"]').waitFor();
  const unreadColor = await page
    .locator('.stage-conversation.unread[data-session="' + unreadSid + '"]')
    .evaluate((el) => ({
      border: getComputedStyle(el).borderColor,
      project: getComputedStyle(el).getPropertyValue('--project-color').trim(),
      label: getComputedStyle(el.querySelector('.stage-caption strong')).color,
    }));
  assert.equal(unreadColor.border, unreadColor.label);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/memory-smart-switcher.png' });
  await page.locator('.stage-conversation[data-session="' + unreadSid + '"]').hover();
  await page.locator('[data-stage-unpin="' + p.id + '::' + unreadSid + '"]').click();
  await page.waitForFunction(
    (sid) => !document.querySelector('.stage-conversation[data-session="' + sid + '"]'),
    unreadSid,
  );
  await page.locator('#crHome').click();

  await page.locator('#crMemoryTab').click();
  await page.locator('[data-memory-tab=knowledge]').click();
  if (!(await page.locator('#memoryStatus').isVisible())) await page.locator('#memoryFilters').click();
  await page.locator('#memoryStatus').selectOption('confirmed');
  await page.locator('#memorySearch').fill('');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/memory-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/memory-mobile.png' });
  assert.ok(await page.locator('#memorySearch').evaluate(el=>el.getBoundingClientRect().right<innerWidth-8));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#memoryNew').click();
  const box = await page.locator('.memory-editor-dialog').boundingBox();
  assert.ok(box.width <= 390 && box.x >= 0);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(
    'Memory workspace, review/versioning, source import, context, results, delivery footer, release freshness and mobile checks passed.',
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
