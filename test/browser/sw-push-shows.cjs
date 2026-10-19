// sw.js shows a notification for EVERY push it receives. Subscriptions are
// userVisibleOnly: a push that shows nothing makes Chrome post a generic notice
// and lets Safari revoke push permission, so whether to push is decided only on
// the server (push.ts). Delivers real pushes to the real service worker through
// the DevTools protocol, so this runs in Chromium only (WebKit has no
// ServiceWorker.deliverPushMessage). Headless Chromium refuses notification
// permission, so the worker's showNotification is recorded rather than drawn:
// what is checked is that sw.js's own push handler calls it for every push.
//   node test/browser/sw-push-shows.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const PUSHES = [
  { title: 'Ordinary finished turn', body: 'A long turn ended', tag: 'x056-conv-a' },
  { title: 'Quiet Bot notice', body: 'Still watching', kind: 'bot_notice', tier: 'normal', tag: 'x056-bot-quiet' },
  { title: 'Screen-suppressed notice', body: 'Should still show', kind: 'bot_notice', tier: 'quiet', screenSuppressed: true, tag: 'x056-bot-suppressed' },
];
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const registrations = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => registrations.push(...e.registrations));
    await cdp.send('ServiceWorker.enable');
    await page.goto(base + '/manifest.webmanifest');
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
    const deadline = Date.now() + 5000;
    let reg; while (!(reg = registrations.find(r => r.scopeURL === base + '/' && !r.isDeleted)) && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(reg, 'service worker registration seen: ' + JSON.stringify(registrations));
    const worker = context.serviceWorkers().find(w => w.url() === base + '/sw.js') || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => { self.__shown = []; self.registration.showNotification = (title, options) => { self.__shown.push({ title, tag: options && options.tag }); return Promise.resolve(); }; });
    for (const push of PUSHES) await cdp.send('ServiceWorker.deliverPushMessage', { origin: base, registrationId: reg.registrationId, data: JSON.stringify(push) });
    const titles = () => worker.evaluate(() => self.__shown.map(n => n.title));
    let shown = await titles();
    for (const end = Date.now() + 8000; shown.length < PUSHES.length && Date.now() < end; shown = await titles()) await page.waitForTimeout(200);
    assert.deepEqual([...shown].sort(), PUSHES.map(p => p.title).sort(), 'every push shows a notification');
    console.log('PASS chromium sw-push-shows: ' + PUSHES.length + ' pushes, ' + shown.length + ' notifications (' + shown.join(' | ') + ')');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
