const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8781';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() =>
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'),
  );
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
  const p = (await api('projects')).projects.find((p) => p.name === 'Website refresh'),
    first = p.conversations[0],
    second = p.conversations[1];
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('.cr-task[data-session="' + first.sessionId + '"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Suggest another title', exact: true }).click();
  await page.locator('.title-suggestion[data-status=ready]').waitFor();
  assert.equal(
    (await api('projects')).projects.find((x) => x.id === p.id).conversations[0].title,
    first.title,
  );
  const dialog = await page.locator('.title-review-dialog').boundingBox();
  assert.ok(dialog.height < 600, 'Single preview should not waste vertical space');
  await page.screenshot({ path: '/tmp/titles-single.png' });
  await page.locator('[data-apply-titles]').click();
  await page.locator('.title-suggestion[data-status=applied]').waitFor();
  await page.keyboard.press('Escape');
  await page
    .locator('.cr-task[data-session="' + first.sessionId + '"] .cr-row-subtitle')
    .filter({ hasText: 'Website layout improvements' })
    .waitFor();
  await page.locator('[data-pin-session="' + first.sessionId + '"]').click();
  await page.locator('#stageToggle').hover();
  await page
    .locator('.stage-conversation[data-session="' + first.sessionId + '"] .stage-caption')
    .filter({ hasText: 'Website layout improvements' })
    .waitFor();
  await page.locator('#crSettings').click();
  await page.locator('#settingsTitles').click();
  await page.locator('.title-settings-form [name=enabled]').uncheck();
  await page.locator('.title-settings-form .cr-primary').click();
  assert.equal((await api('conversation-titles/settings')).enabled, false);
  await page.locator('#settingsTitles').click();
  await page.locator('.title-settings-form [name=enabled]').check();
  await page.locator('.title-settings-form .cr-primary').click();
  await page.locator('#settingsTitles').click();
  await page.locator('[data-title-history]').click();
  await page.locator('[data-undo-title]').first().click();
  await page.locator('.title-suggestion[data-status=undone]').waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page
    .locator('.cr-task[data-session="' + first.sessionId + '"] .cr-row-subtitle')
    .filter({ hasText: first.title })
    .waitFor();
  await page.locator('#crSelectToggle').click();
  for (const sid of [first.sessionId, second.sessionId])
    await page.locator('[data-bulk-key="' + p.id + '::' + sid + '"]').check();
  await page.locator('[data-bulk=titles]').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.title-suggestion[data-status=ready]').length === 2,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/titles-mobile.png' });
  assert.ok(
    await page.locator('.title-review-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.locator('[data-title-select]').first().uncheck();
  assert.match(await page.locator('[data-apply-titles]').textContent(), /Apply title/);
  await page.mouse.click(2, 400);
  await page.waitForFunction(() => !document.querySelector('.title-review-dialog'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#crSelectToggle').click();
  await page.locator('.cr-task[data-session="' + first.sessionId + '"]').click();
  await page.locator('#crNew').evaluate((el) => el.click());
  await page.locator('#prompt').fill('Fix keyboard navigation across the panel');
  await page.locator('#sendBtn').click();
  await page.waitForFunction(
    () => document.querySelector('#projTitle').textContent === 'Keyboard navigation improvements',
    { timeout: 30000 },
  );
  const created = (await api('projects')).projects
    .find((x) => x.id === p.id)
    .conversations.find((c) => c.title === 'Keyboard navigation improvements');
  assert.ok(created);
  assert.equal(created.titleOrigin, 'generated');
  await api('conversations/rename', {
    projectId: p.id,
    sessionId: created.sessionId,
    title: 'My stable conversation name',
  });
  await page.locator('#projTitle').filter({ hasText: 'My stable conversation name' }).waitFor();
  assert.equal(
    (await api('projects')).projects
      .find((x) => x.id === p.id)
      .conversations.find((c) => c.sessionId === created.sessionId).titleOrigin,
    'manual',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Title preview/apply/Undo, settings, bulk review, mobile fit, live auto naming and switcher synchronization passed.',
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
