const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');

const base = process.argv[2] || 'http://127.0.0.1:8791';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
      localStorage.setItem('x056_display_preferences', JSON.stringify({ open: 'side', maximize: 'modal' }));
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const headers = { Authorization: 'Bearer browser-fixture-token-0123456789' };
    const { projects } = await (await context.request.get(base + '/api/projects', { headers })).json();
    const project = projects.find((item) => item.name === 'Website refresh');
    const conversation = project.conversations.find((item) => item.title === 'Build the new homepage');

    const orderedText = async (selector) => page.locator(selector).evaluate((node) =>
      [...node.children]
        .filter((child) => child.matches('strong,small,.cr-row-title,.cr-row-subtitle'))
        .map((child) => ({ text: child.textContent.trim(), y: child.getBoundingClientRect().y }))
        .sort((a, b) => a.y - b.y)
        .map((item) => item.text),
    );
    const expected = (order) => order === 'project'
      ? [project.name, conversation.title]
      : [conversation.title, project.name];

    await page.goto(base);
    const row = page.locator('.cr-task[data-session="' + conversation.sessionId + '"]');
    await row.waitFor();
    assert.equal(await page.locator('body').getAttribute('data-conversation-label-order'), 'conversation');
    assert.deepEqual(await orderedText('.cr-task[data-session="' + conversation.sessionId + '"] .cr-row-copy'), expected('conversation'));

    await page.locator('[data-pin-session="' + conversation.sessionId + '"]').click();
    await page.locator('#stageToggle').hover();
    const bubble = page.locator('.stage-conversation[data-session="' + conversation.sessionId + '"]');
    await bubble.waitFor();
    assert.deepEqual(await orderedText('.stage-conversation[data-session="' + conversation.sessionId + '"] .stage-caption'), expected('conversation'));

    await row.click();
    await page.waitForFunction(title => document.getElementById('projTitle').textContent === title, conversation.title);
    const headerOrder = async () => page.evaluate(() => ['chatProjectName', 'projTitle']
      .map((id) => ({ text: document.getElementById(id).textContent.trim(), y: document.getElementById(id).getBoundingClientRect().y }))
      .sort((a, b) => a.y - b.y)
      .map((item) => item.text));
    assert.deepEqual(await headerOrder(), expected('conversation'));
    await page.locator('#chatClose').click();

    await page.locator('#crSettings').click();
    await page.locator('#conversationLabelOrder [data-value=project]').click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator('body').getAttribute('data-conversation-label-order'), 'project');
    assert.equal(await page.evaluate(() => localStorage.getItem('x056_conversation_label_order')), 'project');
    assert.deepEqual(await orderedText('.cr-task[data-session="' + conversation.sessionId + '"] .cr-row-copy'), expected('project'));
    await page.keyboard.press('Escape');
    await page.locator('#stageToggle').hover();
    assert.deepEqual(await orderedText('.stage-conversation[data-session="' + conversation.sessionId + '"] .stage-caption'), expected('project'));
    await page.screenshot({ path: '/tmp/conversation-label-project.png' });

    await row.click();
    await page.waitForFunction(title => document.getElementById('projTitle').textContent === title, conversation.title);
    assert.deepEqual(await headerOrder(), expected('project'));
    await page.locator('#chatClose').click();
    await page.locator('#crSettings').click();
    await page.locator('#conversationLabelOrder [data-value=conversation]').click();
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => localStorage.getItem('x056_conversation_label_order')), 'conversation');
    assert.deepEqual(await orderedText('.cr-task[data-session="' + conversation.sessionId + '"] .cr-row-copy'), expected('conversation'));
    await page.locator('#stageToggle').hover();
    assert.deepEqual(await orderedText('.stage-conversation[data-session="' + conversation.sessionId + '"] .stage-caption'), expected('conversation'));
    await page.reload();
    await row.waitFor();
    assert.equal(await page.locator('body').getAttribute('data-conversation-label-order'), 'conversation');
    assert.deepEqual(await orderedText('.cr-task[data-session="' + conversation.sessionId + '"] .cr-row-copy'), expected('conversation'));
    assert.deepEqual(errors, []);
    console.log('Conversation label order persists and updates board, switcher, and header in both directions.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
