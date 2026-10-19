// Run against the isolated browser fixture with Chat and Project spaces enabled.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
const output = '.deploy/bot-memory-fixes';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const text = 'Saving the second preference now, then the answer.';
// A first line that fills the column, after another reply (consecutive replies).
const longText = 'Checking the gateway logs and the deployment queue before I change anything else in this repository today, then the answer.';
(async () => {
  mkdirSync(output, { recursive: true });
  const browser = await playwright[engine].launch({ ...(engine === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
    const api = async data => {
      const r = await context.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data });
      assert.ok(r.ok(), await r.text()); return r.json();
    };
    const botName='Spacing Bot '+randomUUID(), ordinaryName='Ordinary visible chat '+randomUUID();
    const bot = await api({ requestId: randomUUID(), name: botName, provider: 'claude' });
    const ordinary = await api({ requestId: randomUUID(), name: ordinaryName, provider: 'claude' });
    const botUrl = '/chat/' + bot.id;
    let question = false;
    // Queue/history are fixed records here; do not mix in the fixture's empty live queue.
    await context.route(/\/api\/sessions\/current\/stream/, r => r.fulfill({ headers:{'Content-Type':'text/event-stream'},body:': fixture heartbeat\n\n' }));
    await context.route('**/api/bot', r => r.fulfill({ json: { enabled: true, projectId: bot.id, sessionId: bot.lastSessionId, url: botUrl, briefAt: '07:30', tz: 'Asia/Jakarta' } }));
    await context.route(/\/api\/projects(\?|$)/, async r => {
      const response = await r.fetch(), data = await response.json();
      for (const p of data.projects) if (p.id === bot.id) {
        p.bot = true; p.running = true; p.runningSessionIds = [bot.lastSessionId];
      }
      await r.fulfill({ response, json: data });
    });
    const queue = [
      { id:'bot-digest-queue',sessionId:bot.lastSessionId,text:'Queued gateway digest',sender:{kind:'bot_event'},at:new Date().toISOString() },
      { id:'human-queue',sessionId:bot.lastSessionId,text:'Queued human instruction',at:new Date().toISOString() },
    ];
    await context.route('**/api/queue', r => r.fulfill({json:{[bot.id]:queue}}));
    await context.route('**/api/questions', r => r.fulfill({ json: question ? [{ projectId: bot.id, sessionId: bot.lastSessionId, question: 'Bot needs your answer', options: ['Continue'], at: new Date().toISOString() }] : [] }));
    await context.route(/\/api\/conversations\/history-page\?/, async r => {
      if (new URL(r.request().url()).searchParams.get('projectId') !== bot.id) return r.continue();
      // Two days old, so every copy/time row carries a date too (its widest form).
      const ts = new Date(Date.now() - 2 * 86400000).toISOString();
      await r.fulfill({ json: { done: true, cursor: null, rows: [
        { role: 'user', text: 'Gateway event digest fixture', sender: { kind: 'bot_event' }, ts },
        { role: 'assistant', text: 'Automated digest response', ts },
        { role: 'user', text: 'Morning brief fixture', sender: { kind: 'bot_brief' }, ts },
        { role: 'assistant', text: 'Automated morning brief', ts },
        { role: 'user', text: 'Advisor system follow-up fixture', sender: { kind: 'advisor', messageId: 'advisor-fixture' }, ts },
        { role: 'assistant', text: 'Bot response to advisor follow-up stays visible.', ts },
        { role: 'user', text: 'Save my preference.', ts },
        { role: 'assistant', text: 'Looking first.', ts },
        { role: 'assistant', text: longText, ts },
        { role: 'action', text: 'Used ToolSearch', ts },
        { role: 'assistant', text, ts },
        ...['memory_propose', 'memory_search', 'memory_approve'].map(name => ({ role: 'action', text: 'Used mcp__x056__' + name, detail: '{}', ts })),
        { role: 'assistant', text: 'Not sent yet (relay checkpoint): synthetic checkpoint', ts },
        { role: 'assistant', text: 'Your preference is saved.', ts },
        { role: 'notice', text: 'Bot status: Quiet routine fixture', ts },
        { role: 'notice', text: 'Bot needs you: Urgent fixture', ts },
      ] } });
    });
    const page = await context.newPage(), errors = [], measurements = [];
    page.on('pageerror', e => errors.push(e.message));
    const go = async path => { if (page.url().startsWith(base)) { await page.waitForFunction(() => window.rcWorkspace?.ready()); await page.evaluate(path => window.rcWorkspace.navigate(path), path); } else await page.goto(base + path); await page.waitForFunction(() => window.rcWorkspace?.ready()); await page.waitForTimeout(700); };
    await go('/home');
    assert.equal(await page.locator('#crLanes [data-project="' + bot.id + '"]').count(), 0, 'Home hides the running Bot');
    await page.locator('#crSearch').fill(ordinaryName);
    await page.locator('#crLanes [data-project="' + ordinary.id + '"]').first().waitFor();
    await page.locator('#crSearch').fill('');
    await page.waitForTimeout(200);
    assert.ok(await page.locator('#workspaceTopBot .bot-orb .bo-eyes').count(), 'navbar reuses the animated orb with eyes');
    assert.ok(await page.locator('#workspaceTopBot').isVisible());
    await page.screenshot({ path: output + '/' + engine + '-home-desktop.png' });
    await page.locator('#crSearch').fill(botName); await page.waitForTimeout(300);
    assert.equal(await page.locator('#crLanes [data-project="' + bot.id + '"]').count(), 0, 'Home search also excludes Bot');
    await go('/activity');
    assert.ok(await page.locator('#crLanes [data-project="' + bot.id + '"]').count(), 'Activity retains Bot');
    await go('/activity/queue');
    await page.locator('#plannerItems [data-queue=human-queue]').waitFor();
    assert.equal(await page.locator('#plannerItems [data-queue=bot-digest-queue]').count(), 0, 'queued digest hidden, human follow-up retained');
    await go('/chat');
    assert.equal(await page.locator('#rcChatList .rc-chat-item').first().getAttribute('data-chat'), bot.id, 'All Chats retains the pinned Bot');
    await page.locator('#workspaceTopBot').click();
    await page.waitForURL(base + botUrl);
    await page.locator('#rcBotHead').waitFor({ state: 'visible' });
    await page.waitForSelector('#workspaceTopBot[aria-current="page"]');
    await page.getByText(text, { exact: true }).waitFor();
    const measure = async () => page.evaluate(text => {
      const msg = [...document.querySelectorAll('#chat>.msg.assistant')].find(e => e._messageText === text);
      const action = msg.nextElementSibling;
      const meta = msg.querySelector('.mmeta');
      const content = msg.querySelector('.content').getBoundingClientRect(), row = action.querySelector('.el').getBoundingClientRect();
      return { width: innerWidth, gap: row.top - content.bottom, rowStep: action.nextElementSibling.getBoundingClientRect().top - action.getBoundingClientRect().top, metaPosition: getComputedStyle(meta).position, overflow: document.documentElement.scrollWidth > innerWidth };
    }, text);
    const checkSpacing = async () => {
      const m = await measure();
      assert.ok(m.gap >= 8 && m.gap <= 20, JSON.stringify(m));
      assert.ok(m.rowStep <= 32, JSON.stringify(m));
      assert.equal(m.metaPosition, 'absolute'); assert.equal(m.overflow, false);
      measurements.push(m);
      assert.equal(await page.locator('#chat>.msg.assistant').last().locator('.mmeta').evaluate(e => getComputedStyle(e).position), 'static', 'final answer keeps its footer');
      // The copy/time row (and its copy tap target) never covers the first line of a reply
      // followed by tool rows, with or without a date in the time.
      const overlaps = await page.evaluate(() => {
        const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return [...document.querySelectorAll('#chat>.msg.assistant')].filter(m => m.offsetParent && m.nextElementSibling?.matches('.act') && m.nextElementSibling.offsetParent).map(m => {
          const meta = m.querySelector('.mmeta').getBoundingClientRect(), button = m.querySelector('.mmeta button').getBoundingClientRect(), content = m.querySelector('.content').getBoundingClientRect();
          const walker = document.createTreeWalker(m.querySelector('.content'), NodeFilter.SHOW_TEXT, { acceptNode: n => n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
          const range = document.createRange(); range.selectNodeContents(walker.nextNode());
          const rects = [...range.getClientRects()], line = rects.filter(r => Math.abs(r.top - rects[0].top) < 2);
          const label = [...m.querySelector('.role').children].map(e => e.getBoundingClientRect()).filter(r => r.width);
          return { text: m._messageText.slice(0, 20), role: getComputedStyle(m.querySelector('.role')).display !== 'none', metaOnLine: line.reduce((a, r) => a + area(r, meta), 0), copyOnLine: line.reduce((a, r) => a + area(r, button), 0), copyBelowLineBox: +(button.bottom - content.top).toFixed(2), metaOnLabel: label.reduce((a, r) => a + area(r, meta), 0), lineWidth: Math.round(line.at(-1).right - line[0].left) };
        });
      });
      assert.ok(overlaps.length >= 2, JSON.stringify(overlaps));
      for (const o of overlaps) {
        assert.ok(o.role, 'role line shown: ' + JSON.stringify(o));
        assert.equal(o.metaOnLine + o.copyOnLine + o.metaOnLabel, 0, 'copy/time row covers text: ' + JSON.stringify(o));
        assert.ok(o.copyBelowLineBox <= 0.5, 'copy target reaches into the first line box: ' + JSON.stringify(o));
      }
      m.overlaps = overlaps;
    };
    await checkSpacing();
    assert.ok(await page.locator('#chat .sender-bot_event').isHidden());
    assert.ok(await page.getByText('Bot status: Quiet routine fixture', {exact:true}).isHidden());
    assert.ok(await page.getByText('Bot needs you: Urgent fixture', {exact:true}).isVisible());
    assert.equal(await page.locator('#queueBar').getByText('Queued gateway digest', {exact:true}).count(), 0);
    await page.locator('#queueBar').getByText('Queued human instruction', {exact:true}).waitFor();
    assert.ok(await page.getByText('Automated digest response', { exact: true }).isHidden());
    // The morning brief's reply stays visible, labelled; its trigger is a system row.
    const brief = page.locator('#chat>.msg.assistant').filter({ hasText: 'Automated morning brief' });
    assert.ok(await brief.isVisible());
    assert.equal(await brief.locator('.bot-brief-tag').innerText(), 'Morning brief');
    assert.ok(await page.locator('#chat .sender-bot_brief').isHidden());
    assert.ok(await page.getByText('Advisor system follow-up fixture', { exact: true }).isHidden());
    assert.ok(await page.getByText('Bot response to advisor follow-up stays visible.', { exact: true }).isVisible());
    assert.ok(await page.getByText('Not sent yet (relay checkpoint): synthetic checkpoint', { exact: true }).isHidden());
    await page.locator('#rcBotToday').click();
    await page.getByRole('button', { name: /^Show \d+ hidden system messages?$/ }).click();
    assert.ok(await page.getByText('Automated digest response', { exact: true }).isVisible());
    assert.ok(await page.getByText('Advisor system follow-up fixture', { exact: true }).isVisible());
    assert.ok(await page.getByText('Not sent yet (relay checkpoint): synthetic checkpoint', { exact: true }).isVisible());
    await page.locator('#rcBotToday').click();
    await page.getByRole('button', { name: 'Hide system messages' }).click();
    assert.ok(await page.getByText('Advisor system follow-up fixture', { exact: true }).isHidden());
    const commentary = page.locator('#chat>.msg.assistant').filter({ hasText: text });
    await commentary.hover();
    await page.waitForFunction(text => { const m = [...document.querySelectorAll('#chat>.msg.assistant')].find(e => e._messageText === text); return getComputedStyle(m.querySelector('.mmeta')).opacity === '1'; }, text);
    assert.equal(await commentary.locator('.mmeta').evaluate(e => getComputedStyle(e).opacity), '1');
    await checkSpacing();
    await page.screenshot({ path: output + '/' + engine + '-bot-desktop.png' });
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(250);
      await checkSpacing();
      const nav = page.locator('#workspaceChatBot');
      assert.ok(await nav.isVisible(), 'phone conversation has a Bot navbar button');
      assert.equal(await nav.getAttribute('aria-current'), 'page');
      assert.ok(await nav.evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
      if (width === 390) await page.screenshot({ path: output + '/' + engine + '-bot-iphone.png' });
    }
    await go('/home');
    assert.ok(await page.locator('#workspaceTopBot').isVisible(), 'phone Home has the Bot button');
    assert.equal(await page.locator('#workspaceTopBot').getAttribute('aria-current'), null);
    await page.screenshot({ path: output + '/' + engine + '-home-iphone.png' });
    await page.locator('#workspaceTopBot').click(); await page.waitForURL(base + botUrl);
    question = true;
    await page.locator('#rcBotHead').waitFor({ state: 'visible' });
    await page.locator('#chatRefresh').evaluate(e => e.click());
    await page.getByText('Conversation refreshed.', {exact:true}).waitFor();
    await go('/home');
    const attention = page.locator('.cr-conversation-group').filter({ has: page.getByRole('heading', { name: 'Needs attention' }) });
    assert.ok(await attention.locator('[data-project="' + bot.id + '"]').count(), 'Bot requests remain in Home attention');
    await page.locator('#crNotifications').click();
    assert.ok(await page.locator('.rc-notification-dialog').getByText('Bot needs your answer').isVisible(), 'Bot stays in notifications');
    assert.deepEqual(errors, []);
    writeFileSync(output + '/' + engine + '-spacing.json', JSON.stringify(measurements, null, 2));
    console.log('PASS ' + engine + ': Home filtering, attention and notifications, navbar navigation and active state, spacing and copy controls at desktop/320/390/430px. ' + JSON.stringify(measurements));
  } finally { for (const c of browser.contexts()) await c.unrouteAll({behavior:'ignoreErrors'}); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
