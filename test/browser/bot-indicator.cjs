// The Bot's two-kind indicator and its name. FYI (an unread Bot message) is a small dot, Needs me (pending
// questions) a pill with the count, on the sidebar's Bot entry, both top-bar Bot buttons (a badge over the orb on
// phones) and the /chat Bot row. The data is the server's: the Bot's /api/projects row (botAttention, botName),
// GET /api/bot (attention, name) and the live bot_attention event, mocked here. Plus the rename flow
// (POST /api/bot {name}, the server's 400 message shown inline) and that the name reaches every label, escaped.
// Run against the isolated browser fixture with Chat and Project spaces enabled:
//   X056_TEST_BROWSER=chromium|webkit node test/browser/bot-indicator.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const shots = process.env.X056_SHOTS;

// WCAG contrast of two computed rgb()/rgba() colours.
const lum = c => { const scale = /^color\(srgb/.test(c) ? 255 : 1; const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v * scale).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const checks = [], errors = [];
  const pageError = e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); };
  const check = (name, ok, detail) => { assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks.push(name); };
  try {
    const phone = playwright.devices['iPhone 13'];
    const admin = await browser.newContext();
    const api = async data => { const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data }); assert.ok(r.ok(), await r.text()); return r.json(); };
    const bot = await api({ requestId: randomUUID(), name: 'Indicator Bot ' + randomUUID(), provider: 'claude' });
    const other = await api({ requestId: randomUUID(), name: 'Ordinary ' + randomUUID(), provider: 'claude' });
    await admin.close();
    const botPath = '/chat/' + bot.id;

    // One mocked server: the Bot record, what was posted, and a stream the test drives.
    const make = async options => {
      const context = await browser.newContext({ serviceWorkers: 'block', ...options });
      await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
      if (options.colorScheme === 'dark') await context.addInitScript(() => localStorage.setItem('x056_theme', 'dark'));
      await context.addInitScript(() => {
        class FakeSource { constructor(url) { this.url = url; this.l = {}; window.__es = this; setTimeout(() => this.onopen && this.onopen({}), 0); } addEventListener(k, f) { (this.l[k] = this.l[k] || []).push(f); } close() {} }
        window.EventSource = FakeSource;
        window.__emit = (kind, data) => (window.__es.l[kind] || []).forEach(f => f({ data: JSON.stringify({ data, ts: new Date().toISOString() }), lastEventId: '' }));
      });
      const server = { name: 'Bot', attention: { needsMe: 0, fyi: false }, posted: [], send: null };
      const record = () => ({ enabled: server.enabled !== false, projectId: bot.id, sessionId: bot.lastSessionId, url: server.enabled === false ? null : botPath, briefAt: '07:30', tz: 'Asia/Jakarta', name: server.name, attention: server.attention });
      await context.route('**/api/bot', async r => {
        if (r.request().method() === 'POST') {
          const body = r.request().postDataJSON(); server.posted.push(body);
          if (typeof body.name === 'string' && /[<>]/.test(body.name)) return r.fulfill({ status: 400, json: { message: 'The name cannot contain < or >.' } });
          if (typeof body.name === 'string') server.name = body.name;
        }
        await r.fulfill({ json: record() });
      });
      await context.route(/\/api\/projects(\?|$)/, async r => {
        const response = await r.fetch(), data = await response.json();
        for (const p of data.projects) if (p.id === bot.id) { p.bot = true; p.botName = server.name; p.botAttention = server.attention; }
        await r.fulfill({ response, json: data });
      });
      await context.route('**/api/questions', r => r.fulfill({ json: [] }));
      await context.route('**/api/bot/overview*', r => r.fulfill({ json: { needsYou: [], running: [], delegates: [], scheduled: [] } }));
      await context.route(/\/api\/conversations\/history-page\?/, r => new URL(r.request().url()).searchParams.get('projectId') !== bot.id ? r.continue() : r.fulfill({ json: { done: true, cursor: null, rows: [{ role: 'user', text: 'Hello', ts: new Date(Date.now() - 5000).toISOString() }, { role: 'assistant', text: 'Hello there', ts: new Date(Date.now() - 4000).toISOString() }] } }));
      return { context, server };
    };
    const open = async (page, path) => {
      if (page.url().startsWith(base)) await page.evaluate(p => window.rcWorkspace.navigate(p), path); else await page.goto(base + path);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.waitForTimeout(500);
    };
    // The server's attention changes: update the mock and tell the panel the way the gateway does.
    const attend = async (page, server, attention) => { server.attention = attention; await page.evaluate(a => window.__emit('bot_attention', a), attention); await page.waitForTimeout(150); };
    const badge = (page, sel) => page.evaluate(s => { const e = document.querySelector(s + ' .bot-ind'); if (!e) return null; const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(), cs = getComputedStyle(e); return { kind: e.dataset.kind, text: e.textContent, label: e.getAttribute('aria-label'), w: r.width, h: r.height, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, nearParent: r.right <= p.right + 6 && r.left >= p.left - 6, bg: cs.backgroundColor, color: cs.color, vis: cs.visibility !== 'hidden' && r.width > 0 }; }, sel);
    const attr = (page, sel, name) => page.locator(sel).first().getAttribute(name);
    const none = async (page, where) => { for (const s of ['#workspaceBot', '#workspaceTopBot', '#workspaceChatBot', '.rc-chat-item[data-chat="' + bot.id + '"]']) if ((await page.locator(s + ' .bot-ind').count()) !== 0) return false; return true; };

    // 1. Desktop: the sidebar entry and the top bar, from the projects row, then live events, in light and dark.
    for (const scheme of ['light', 'dark']) {
      const { context, server } = await make({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, '/home');
      check(scheme + ': no attention, no badge, plain labels', await none(page) && (await attr(page, '#workspaceTopBot', 'aria-label')) === 'Open Bot' && (await page.locator('#workspaceBot').getAttribute('aria-label')) === 'Bot');

      // From the row: reload projects the way a 'projects' event does.
      server.attention = { needsMe: 0, fyi: true };
      await page.evaluate(() => window.__emit('projects', {})); await page.waitForTimeout(700);
      for (const sel of ['#workspaceBot', '#workspaceTopBot']) {
        const b = await badge(page, sel);
        check(scheme + ': FYI is a small dot on ' + sel + ' (from the projects row)', b && b.kind === 'fyi' && b.text === '' && b.w <= 12 && b.h <= 12 && b.vis && b.inside, b);
      }
      check(scheme + ': FYI labels say "Bot: new message"', (await attr(page, '#workspaceBot', 'aria-label')) === 'Bot: new message' && (await attr(page, '#workspaceTopBot', 'aria-label')) === 'Bot: new message' && (await attr(page, '#workspaceBot .bot-ind', 'aria-label')) === 'Bot: new message');
      const dot = await badge(page, '#workspaceBot'), side = await page.evaluate(() => getComputedStyle(document.getElementById('crProjectNav')).backgroundColor);
      check(scheme + ': the FYI dot is at least 3:1 against the sidebar', contrast(dot.bg, side) >= 3, [dot.bg, side, contrast(dot.bg, side)]);
      if (shots && scheme === 'light') await page.screenshot({ path: `${shots}/indicator-fyi-desktop-light${engine === 'webkit' ? '-webkit' : ''}.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });

      // Live: Needs me, count 2, wins over FYI.
      await attend(page, server, { needsMe: 2, fyi: true });
      for (const sel of ['#workspaceBot', '#workspaceTopBot']) {
        const b = await badge(page, sel);
        check(scheme + ': Needs me is a pill with the count on ' + sel + ' and wins over FYI', b && b.kind === 'needs' && b.text === '2' && b.w >= 16 && b.vis && b.inside, b);
      }
      check(scheme + ': Needs me labels say "Bot: 2 need you"', (await attr(page, '#workspaceBot', 'aria-label')) === 'Bot: 2 need you' && (await attr(page, '#workspaceTopBot', 'aria-label')) === 'Bot: 2 need you');
      const pill = await badge(page, '#workspaceBot');
      check(scheme + ': the pill text is at least 4.5:1 on its fill', contrast(pill.bg, pill.color) >= 4.5, [pill.bg, pill.color, contrast(pill.bg, pill.color)]);
      check(scheme + ': the pill is not the violet background-work colour', !/^rgb\(109, 40, 217\)|^rgb\(167, 139, 250\)/.test(pill.bg), pill.bg);
      if (shots) await page.screenshot({ path: `${shots}/indicator-needs-desktop-${scheme}${engine === 'webkit' ? '-webkit' : ''}.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });
      await attend(page, server, { needsMe: 1, fyi: false });
      check(scheme + ': one is "Bot: 1 needs you"', (await attr(page, '#workspaceBot', 'aria-label')) === 'Bot: 1 needs you' && (await badge(page, '#workspaceBot')).text === '1');

      // /chat: the Bot row carries it too.
      await open(page, '/chat');
      await page.locator('.rc-chat-item[data-chat="' + bot.id + '"]').waitFor();
      const row = await badge(page, '.rc-chat-item[data-chat="' + bot.id + '"]');
      check(scheme + ': the /chat Bot row shows Needs me', row && row.kind === 'needs' && row.text === '1' && row.label === 'Bot: 1 needs you' && row.vis, row);
      check(scheme + ': ordinary chat rows have none', (await page.locator('.rc-chat-item:not([data-chat="' + bot.id + '"]) .bot-ind').count()) === 0);
      await attend(page, server, { needsMe: 0, fyi: true });
      check(scheme + ': the /chat row falls back to FYI', (await badge(page, '.rc-chat-item[data-chat="' + bot.id + '"]')).kind === 'fyi');

      // Clears when the server says so (read / answered), everywhere.
      await attend(page, server, { needsMe: 0, fyi: false });
      check(scheme + ': cleared by bot_attention on every surface, labels restored', await none(page) && (await attr(page, '#workspaceTopBot', 'aria-label')) === 'Open Bot' && (await page.locator('#workspaceBot').getAttribute('aria-label')) === 'Bot');
      // The nested copy iOS reads (attention: {...}) works as well as the flat event, and an event can carry the name.
      server.attention = { needsMe: 2, fyi: false };
      await page.evaluate(() => window.__emit('bot_attention', { projectId: null, name: 'Bot', attention: { needsMe: 2, fyi: false } })); await page.waitForTimeout(150);
      check(scheme + ': a nested attention is read too', (await badge(page, '#workspaceBot')).text === '2');
      await attend(page, server, { needsMe: 0, fyi: false });
      // A later reload of the row does not bring back an older value.
      server.attention = { needsMe: 0, fyi: false };
      await page.evaluate(() => window.__emit('projects', {})); await page.waitForTimeout(600);
      check(scheme + ': a projects reload keeps it cleared', await none(page));
      await context.close();
    }

    // 2. Phones: the top bar shows the orb alone, with the badge over it, on the workspace pages and in a conversation.
    for (const [name, path, sel] of [['home', '/home', '#workspaceTopBot'], ['chat', botPath.replace(bot.id, other.id), '#workspaceChatBot']]) {
      const { context, server } = await make({ ...phone, viewport: { width: 390, height: 844 } });
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, path);
      for (const [label, attention] of [['FYI', { needsMe: 0, fyi: true }], ['Needs me', { needsMe: 3, fyi: true }]]) {
        await attend(page, server, attention);
        const b = await badge(page, sel), box = await page.locator(sel).boundingBox();
        check('phone ' + name + ': ' + label + ' badge sits on the orb, on screen', b && b.vis && b.inside && b.nearParent && box.width < 70, [b, box]);
        check('phone ' + name + ': ' + label + ' label on the button', (await attr(page, sel, 'aria-label')) === (attention.needsMe ? 'Bot: 3 need you' : 'Bot: new message'));
        check('phone ' + name + ': the button text stays hidden (orb only)', await page.evaluate(s => getComputedStyle(document.querySelector(s + ' .ws-bot-name')).display === 'none', sel));
        if (shots) await page.screenshot({ path: `${shots}/indicator-${attention.needsMe ? 'needs' : 'fyi'}-phone-${name}-${engine}.png`, clip: { x: 0, y: 0, width: 390, height: 260 } });
      }
      await attend(page, server, { needsMe: 0, fyi: false });
      check('phone ' + name + ': cleared', await none(page));
      await context.close();
    }

    // 3. Rename: the settings dialog, the server's 400 inline, then the name on every label (escaped).
    {
      const { context, server } = await make({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.locator('#rcBotHead').waitFor({ state: 'visible' });
      await page.locator('#rcBotSettings').click();
      const dlg = page.locator('dialog.rc-bot-settings[open]');
      const nameInput = dlg.getByLabel('Name', { exact: true });
      check('settings has a Name field holding the current name', await nameInput.inputValue() === 'Bot');
      // Unchanged name: the save sends no name (a rename restarts the Bot's process).
      await dlg.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(300);
      check('saving without a rename sends no name', server.posted.length === 1 && !('name' in server.posted[0]), server.posted);
      await page.waitForTimeout(900);
      await page.locator('#rcBotSettings').click();
      await nameInput.fill('Bad <name>'); await dlg.getByRole('button', { name: 'Save' }).click();
      await dlg.locator('[role=alert]').filter({ hasText: 'cannot contain' }).waitFor();
      check('the server\'s 400 message is shown inline and the dialog stays', (await dlg.locator('[role=alert]').innerText()) === 'The name cannot contain < or >.' && await dlg.isVisible());
      if (shots) await page.screenshot({ path: `${shots}/rename-error-desktop-${engine}.png` });
      const NAME = 'Jarvis & "Co"';
      await nameInput.fill(NAME); await dlg.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => !document.querySelector('dialog.rc-bot-settings[open]'), null, { timeout: 5000 });
      check('the rename was posted with the name', server.posted.at(-1).name === NAME, server.posted.at(-1));
      const text = sel => page.locator(sel).first().innerText();
      check('header badge reads the name', (await text('#rcBotHead .rc-bot-badge')) === NAME);
      check('header orb and settings button read the name', (await attr(page, '#rcBotHead .bot-orb', 'aria-label')) === NAME + ' is idle' && (await attr(page, '#rcBotSettings', 'aria-label')) === NAME + ' settings');
      check('sidebar destination reads the name', (await text('#workspaceBot')).trim() === NAME);
      check('top-bar buttons read the name', (await attr(page, '#workspaceTopBot', 'aria-label')) === 'Open ' + NAME && (await attr(page, '#workspaceChatBot', 'aria-label')) === 'Open ' + NAME && (await page.locator('#workspaceTopBot .ws-bot-name').textContent()) === NAME);
      await attend(page, server, { needsMe: 1, fyi: false });
      check('attention labels use the name', (await attr(page, '#workspaceBot', 'aria-label')) === NAME + ': 1 needs you');
      await attend(page, server, { needsMe: 0, fyi: false });
      await open(page, '/chat');
      await page.locator('.rc-chat-item[data-chat="' + bot.id + '"]').waitFor();
      check('/chat row reads the name', (await text('.rc-chat-item[data-chat="' + bot.id + '"] .rc-bot-badge')) === NAME);
      // The Bot off: /bot is the setup card and the route title, both with the name.
      server.enabled = false;
      await page.evaluate(() => window.rcWorkspace.navigate('/bot')); await page.locator('#rcBotSetupTitle').waitFor({ state: 'visible' });
      check('the setup card and the route title read the name', (await text('#rcBotSetupTitle')) === 'Set up ' + NAME && (await text('#crBreadcrumb')).includes(NAME) && (await text('#rcBotSetupForm button[type=submit]')) === 'Enable ' + NAME);
      server.enabled = true;
      // The name reloaded from the server (a fresh page) is the same.
      await page.reload(); await page.waitForFunction(() => window.rcWorkspace?.ready()); await page.waitForTimeout(700);
      check('after a reload the name is still on the sidebar and top bar', (await text('#workspaceBot')).trim() === NAME && (await attr(page, '#workspaceTopBot', 'aria-label')) === 'Open ' + NAME);
      // Defence in depth: whatever the server sends is text, never markup.
      server.name = '<i id="xss">x</i>';
      await page.evaluate(() => window.__emit('projects', {})); await page.waitForTimeout(700);
      await open(page, '/chat'); await page.locator('.rc-chat-item[data-chat="' + bot.id + '"]').waitFor();
      check('a name with markup is shown as text everywhere', (await page.locator('#xss').count()) === 0 && (await text('#workspaceBot')).trim() === '<i id="xss">x</i>' && (await text('.rc-chat-item[data-chat="' + bot.id + '"] .rc-bot-badge')) === '<i id="xss">x</i>');
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} bot-indicator: ${checks.length} checks`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
