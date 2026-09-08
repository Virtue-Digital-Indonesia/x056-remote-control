const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8795';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const { projects } = await (await context.request.get(base + '/api/projects', {
      headers: { Authorization: 'Bearer browser-fixture-token-0123456789' },
    })).json();
    const website = projects.find(p => p.name === 'Website refresh');
    const research = projects.find(p => p.name === 'Research workspace');
    const question = website.conversations.find(c => c.title === 'Build the new homepage');
    const idle = website.conversations.find(c => c.title === 'Update the component library');
    const running = research.conversations[0];
    const extra = ['background', 'failed', 'finished', 'parked'].map(status => ({
      sessionId: 'state-' + status, title: status + ' conversation', provider: 'claude',
      lastMessageAt: Date.now(),
      ...(['failed', 'finished', 'parked'].includes(status) ? {
        lastOutcome: { status: status === 'finished' ? 'completed' : status, at: Date.now() },
      } : {}),
    }));
    website.conversations.push(...extra);
    website.backgroundSessionIds = ['state-background'];
    research.runningSessionIds = [running.sessionId];
    const pins = [question, idle, ...extra].map(c => website.id + '::' + c.sessionId)
      .concat(research.id + '::' + running.sessionId);
    await context.addInitScript(pins => {
      localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
      localStorage.setItem('x056_stage_pins', JSON.stringify(pins));
      localStorage.setItem('x056_display_preferences', JSON.stringify({ open: 'side', maximize: 'modal' }));
    }, pins);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/projects', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, projects } });
    });
    await page.goto(base);
    await page.locator('.cr-task').first().waitFor();
    await page.locator('#stageToggle').hover();
    await page.waitForFunction(() => document.querySelectorAll('.stage-conversation').length === 7);
    assert.equal(await page.locator('.cr-project-color').count(), 0);
    assert.equal(await page.locator('.cr-project-link[data-scope]:not([data-scope=""]) use[href="#i-folder"]').count(), projects.length);
    assert.equal(await page.locator('.stage-conversation[aria-current=true]').count(), 0, 'closed chats have no selected marker');

    const mark = async (sid, unread) => {
      await page.locator('.cr-task[data-session="' + sid + '"]').click({ button: 'right' });
      const action = page.getByRole('menuitem', { name: unread ? 'Mark as unread' : 'Mark as read', exact: true });
      if (await action.count()) await action.click(); else await page.keyboard.press('Escape');
    };
    await mark(question.sessionId, false);
    await page.locator('#stageToggle').hover();
    // State colors agree across the overview and switcher in both themes.
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(theme => (document.documentElement.dataset.theme || 'light') === theme, theme);
      await page.waitForTimeout(300);
      const colors = await page.locator('.stage-conversation').evaluateAll(elements =>
        Object.fromEntries(elements.map(el => [el.dataset.chatState, getComputedStyle(el).borderTopColor])));
      assert.equal(new Set(Object.values(colors)).size, 6, 'idle and finished share grey; other states differ');
      assert.equal(colors.idle, colors.finished);
      for (const [status, color] of Object.entries(colors)) {
        const dots = page.locator('.cr-task .cr-state-dot[data-chat-state="' + status + '"]');
        if (await dots.count()) assert.equal(await dots.first().evaluate(el => getComputedStyle(el).backgroundColor), color);
      }
      const rgb = color => color.match(/\d+/g).slice(0, 3).map(Number);
      const [r, g, b] = rgb(colors.running);
      assert.ok(g > r && g > b, 'running is green');
      assert.ok(rgb(colors.question)[0] > rgb(colors.question)[1] && rgb(colors.question)[1] > rgb(colors.question)[2], 'questions are orange');
      assert.ok(rgb(colors.failed)[0] > rgb(colors.failed)[1], 'failure is red');
      assert.ok(rgb(colors.background)[2] > rgb(colors.background)[1], 'background work is purple');
    }

    // Every underlying state yields its main color to unread, including completion.
    const runBubble = page.locator('.stage-conversation[data-session="' + running.sessionId + '"]');
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const [sid, status] of [[running.sessionId, 'running'], [question.sessionId, 'question'], ...extra.map(c => [c.sessionId, c.sessionId.slice(6)])]) {
        await mark(sid, true);
        await page.locator('#stageToggle').hover();
        await page.waitForTimeout(300);
        const unread = await page.locator('.stage-conversation[data-session="' + sid + '"]').evaluate(el => ({
          color: getComputedStyle(el).borderTopColor,
          fill: getComputedStyle(el).backgroundColor,
          label: getComputedStyle(el.querySelector('strong')).color,
          dot: getComputedStyle(el.querySelector('.stage-status')).backgroundColor,
          state: el.dataset.chatState,
        }));
        assert.equal(unread.state, status);
        assert.equal(unread.color, unread.label);
        assert.equal(unread.fill, unread.color, 'unread has a filled bubble');
        assert.notEqual(unread.color, unread.dot, 'small dot preserves underlying state');
        if (!['running', 'finished'].includes(status)) await mark(sid, false);
      }
    }

    const idleBubble = page.locator('.stage-conversation[data-session="' + idle.sessionId + '"]');
    await page.locator('#stageToggle').hover();
    await idleBubble.click();
    const selected = page.locator('.stage-conversation[aria-current=true]');
    await page.waitForFunction(sid => document.querySelector('.stage-conversation[aria-current=true]')?.dataset.session === sid, idle.sessionId);
    assert.equal(await page.locator('.stage-viewing').count(), 0);
    const currentStyle = await selected.evaluate(el => ({ fill: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor, outline: getComputedStyle(el).outlineStyle }));
    assert.notEqual(currentStyle.fill, currentStyle.border, 'read selected chats use only an outline');
    assert.equal(currentStyle.outline, 'solid');
    const anchor = await page.locator('#stageToggle').boundingBox();
    for (const mode of ['side', 'modal', 'page']) {
      if (mode !== 'side') await page.locator('#chatMax').click();
      assert.equal(await page.locator('body').getAttribute('data-chat-mode'), mode);
      assert.deepEqual(await page.locator('#stageToggle').boundingBox(), anchor);
      assert.equal(await selected.getAttribute('data-session'), idle.sessionId);
    }
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('#stageToggle').hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: '/tmp/conversation-states-' + theme + '.png' });
    }
    await runBubble.click();
    await page.waitForFunction(sid => document.querySelector('.stage-conversation[aria-current=true]')?.dataset.session === sid, running.sessionId);
    assert.equal(await page.locator('.stage-viewing').count(), 0);
    assert.equal(await runBubble.evaluate(el => el.classList.contains('unread')), false, 'opening clears unread priority');
    assert.equal(await idleBubble.getAttribute('aria-current'), null);
    assert.equal(await idleBubble.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.locator('#chatClose').click();
    assert.equal(await selected.count(), 0, 'closing clears the selected treatment immediately');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#conversationStage').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: state colors in both themes, neutral project icons, unread color priority, selected-chat transitions and stable desktop positioning.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
