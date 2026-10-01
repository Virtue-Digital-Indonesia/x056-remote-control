// Run fixture.ts first, then: node test/browser/notifications.cjs [base URL]
// The bell dialog speaks the event's notice; Settings > Notifications saves per
// device; the panel reports presence. SHOTS=<dir> also writes screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8799';
const shots = process.env.SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
const ENDPOINT = 'https://push.invalid/device-1';

async function boot(browser, { width = 1440, height = 1000, theme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(({ endpoint, theme }) => {
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
    localStorage.setItem('x056_theme', theme);
    const Original = EventSource;
    window.EventSource = class extends Original { constructor(...a) { super(...a); window.__source = this; } };
    window.__notices = [];
    window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(title, o) { window.__notices.push({ title, ...o }); } };
    const sub = { endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
    sub.toJSON = () => ({ endpoint: sub.endpoint, keys: sub.keys });
    navigator.serviceWorker.register = () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(sub), subscribe: () => Promise.resolve(sub) } });
  }, { endpoint: ENDPOINT, theme });
  await context.route('**/control-room.js*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\n{const o=window.createControlRoom;window.createControlRoom=function(e){window.__engine=e;return o(e);};}' });
  });
  const page = await context.newPage(), errors = [], presence = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().endsWith('/api/presence') && r.method() === 'POST') presence.push(JSON.parse(r.postData() || '{}')); });
  return { context, page, errors, presence };
}

(async () => {
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const { page, errors, presence } = await boot(browser);
    await page.goto(base);
    await page.locator('.cr-task').first().waitFor();

    // 1. Presence: reported with this device's endpoint, and again on a change.
    await page.waitForFunction(() => true);
    await page.waitForTimeout(1500);
    assert.ok(presence.length >= 1, 'POST /api/presence is sent on load');
    assert.equal(presence.at(-1).visible, true);
    assert.equal(presence.at(-1).endpoint, ENDPOINT);
    assert.ok(presence.at(-1).clientId);
    const before = presence.length;
    await page.locator('.cr-task').first().click();
    await page.waitForFunction(() => !document.getElementById('conversationSurface').hidden);
    await page.waitForTimeout(1500);
    const opened = presence.slice(before).find((p) => p.sessionId);
    assert.ok(opened, 'opening a conversation reports it');
    assert.equal(opened.sessionId, await page.evaluate(() => window.__engine.state().sessionId));
    await page.locator('#chatClose').click();
    await page.waitForTimeout(300);

    // 2. The bell uses the notices' words, grouped by tier, with times.
    const targets = await page.evaluate(() => {
      const s = window.__engine.state(), out = [];
      for (const p of s.projects) for (const c of p.conversations || []) if (!s.questions[c.sessionId]) out.push({ projectId: p.id, sessionId: c.sessionId });
      return out;
    });
    assert.ok(targets.length >= 3, 'fixture has three conversations without questions');
    const emit = (kind, target, data) => page.evaluate(({ kind, data }) => window.__source.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify({ data, ts: new Date().toISOString() }) })), { kind, data: { ...target, ...data } });
    const n = (tier, title, body, extra = {}) => ({ tier, category: tier === 'urgent' ? 'needs_you' : 'finished', kind: 'conversation_settled', title, body, link: '/', tag: 'x056-conv-' + title, id: title, ...extra });
    await emit('conversation_settled', targets[0], { status: 'completed', notice: n('normal', 'Fix deed numbers', 'ocr · Claude\n4m 12s · Deed numbers keep their leading zeros now.') });
    await emit('conversation_settled', targets[1], { status: 'completed', notice: n('quiet', 'Nightly digest', 'ocr · ChatGPT\n18s · Nothing new overnight.') });
    await emit('session_done', targets[2], { status: 'failed', reason: 'boom', notice: n('urgent', 'Release notes', 'ocr · Claude\nSign-in expired for account g', { kind: 'session_done' }) });
    await page.waitForTimeout(200);
    assert.match(await page.title(), /^\(\d+\) /, 'document title counts what needs you');
    await page.locator('#crNotifications').click();
    const dialog = page.locator('.rc-notification-dialog');
    await dialog.waitFor();
    const groups = await dialog.locator('.rc-notification-group h3').allTextContents();
    assert.deepEqual(groups.filter((g) => ['Needs you', 'Recent', 'Earlier'].includes(g)), groups);
    assert.ok(groups.includes('Earlier') && groups.includes('Recent') && groups.includes('Needs you'));
    const text = await dialog.innerText();
    for (const s of ['Fix deed numbers', '4m 12s · Deed numbers keep their leading zeros now.', 'Nightly digest', 'Sign-in expired for account g', 'Just now']) assert.ok(text.includes(s), 'bell shows: ' + s);
    assert.ok(!/tap to (continue|resume)/i.test(text));
    const earlier = dialog.locator('.rc-notification-group').filter({ hasText: 'Earlier' });
    assert.ok((await earlier.innerText()).includes('Nightly digest'), 'a quiet notice sits under Earlier');
    if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: shots + '/bell-1440-dark.png' }); }
    const count = await dialog.locator('.rc-notification-item').count();
    await dialog.getByRole('button', { name: 'Mark Nightly digest as read' }).click();
    assert.equal(await dialog.locator('.rc-notification-item').count(), count - 1, 'Mark as read removes the item');
    await dialog.getByRole('button', { name: 'Close notifications' }).click();

    // 2b. The restart notice, once dismissed, stays dismissed across a reload
    //     (the server replays its buffer on every load).
    const restart = { count: 2, bootAt: 'boot-1', notice: { tier: 'normal', category: 'needs_you', kind: 'restart_interrupted', title: 'x056 restarted', body: '2 conversations were interrupted by a restart. Open them to resume.', link: '/', tag: 'x056-restart', id: 'restart:boot-1' } };
    await emit('restart_interrupted', {}, restart);
    assert.equal(await page.evaluate(() => window.__engine.state().restartNotice?.bootAt), 'boot-1');
    await page.evaluate(() => window.__engine.clearRestartNotice());
    await page.reload(); await page.locator('.cr-task').first().waitFor();
    await emit('restart_interrupted', {}, restart);
    assert.equal(await page.evaluate(() => window.__engine.state().restartNotice), null, 'a dismissed restart does not come back on reload');

    // 3. Settings > Notifications: per-device toggles persist on the gateway.
    await page.goto(base + '/settings/notifications');
    await page.locator('#notifyFinished:not([disabled])').waitFor();
    await page.waitForFunction(() => !document.getElementById('notifyPrefs').disabled);
    assert.equal(await page.locator('#notifyState').innerText(), 'On');
    assert.equal(await page.locator('#notifyFinished').isChecked(), true);
    assert.equal(await page.locator('#notifyAutomation').isChecked(), false);
    assert.equal(await page.locator('#notifyNeeds').isDisabled(), true, '"Needs you" cannot be switched off');
    await page.locator('#notifyAutomation').check();
    await page.locator('#notifyStatus').filter({ hasText: 'Saved for this device.' }).waitFor();
    await page.locator('#notifyQuiet').check();
    await page.locator('#notifyStatus').filter({ hasText: 'Saved' }).waitFor();
    await page.locator('#notifyQuietStart').fill('23:00');
    await page.locator('#notifyQuietStart').dispatchEvent('change');
    await page.waitForTimeout(400);
    if (shots) await page.screenshot({ path: shots + '/settings-1440-dark.png' });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('notifyPrefs') && !document.getElementById('notifyPrefs').disabled);
    assert.equal(await page.locator('#notifyAutomation').isChecked(), true, 'automation toggle persisted');
    assert.equal(await page.locator('#notifyQuiet').isChecked(), true, 'quiet hours persisted');
    assert.equal(await page.locator('#notifyQuietStart').inputValue(), '23:00');
    const saved = await page.evaluate((ep) => fetch('/api/push/settings?endpoint=' + encodeURIComponent(ep), { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } }).then((r) => r.json()), ENDPOINT);
    assert.equal(saved.automation, true);
    assert.equal(saved.subscribed, true);
    assert.ok(saved.timeZone, 'the device zone is stored for quiet hours');
    await page.locator('#notifyTest').click();
    await page.locator('#notifyStatus').filter({ hasText: /Sent\.|not subscribed/ }).waitFor();
    assert.equal(await page.locator('#notifyStatus').innerText(), 'Sent. It should arrive in a few seconds.');
    // Leave the device as it was for any later test on this fixture.
    await page.locator('#notifyAutomation').uncheck(); await page.locator('#notifyQuiet').uncheck(); await page.waitForTimeout(400);
    assert.deepEqual(errors, []);

    if (shots) {
      for (const [w, h, theme] of [[390, 844, 'dark'], [390, 844, 'light'], [1440, 1000, 'light']]) {
        const b = await boot(browser, { width: w, height: h, theme });
        await b.page.goto(base); await b.page.locator('.cr-task').first().waitFor();
        await b.page.waitForTimeout(600);
        const t = await b.page.evaluate(() => { const s = window.__engine.state(), out = []; for (const p of s.projects) for (const c of p.conversations || []) if (!s.questions[c.sessionId]) out.push({ projectId: p.id, sessionId: c.sessionId }); return out; });
        const e2 = (kind, target, data) => b.page.evaluate(({ kind, data }) => window.__source.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify({ data, ts: new Date().toISOString() }) })), { kind, data: { ...target, ...data } });
        await e2('conversation_settled', t[0], { status: 'completed', notice: n('normal', 'Fix deed numbers', 'ocr · Claude\n4m 12s · Deed numbers keep their leading zeros now.') });
        await e2('conversation_settled', t[1], { status: 'completed', notice: n('quiet', 'Nightly digest', 'ocr · ChatGPT\n18s · Nothing new overnight.') });
        await e2('session_done', t[2], { status: 'failed', notice: n('urgent', 'Release notes', 'ocr · Claude\nSign-in expired for account g') });
        await b.page.waitForTimeout(200);
        if (w < 600 && await b.page.locator('#crNotifications').isHidden()) await b.page.locator('#crSettings, #focusSettings').first().isVisible();
        await b.page.locator('#crNotifications').click({ force: true });
        await b.page.locator('.rc-notification-dialog').waitFor();
        await b.page.waitForTimeout(500); // let the open animation finish
        await b.page.screenshot({ path: `${shots}/bell-${w}-${theme}.png` });
        await b.page.goto(base + '/settings/notifications');
        await b.page.waitForFunction(() => document.getElementById('notifyPrefs') && !document.getElementById('notifyPrefs').disabled);
        await b.page.waitForTimeout(400);
        await b.page.screenshot({ path: `${shots}/settings-${w}-${theme}.png`, fullPage: false });
        await b.context.close();
      }
    }
    console.log('PASS: bell speaks the notices, settings persist per device, presence is reported');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
