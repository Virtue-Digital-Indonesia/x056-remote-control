// Preload for running a chromium-only browser test (one that does require(playwright).chromium)
// in WebKit without editing it:
//   PLAYWRIGHT_BROWSERS_PATH=... node -r ./test/browser/webkit-preload.cjs test/browser/bot-header.cjs http://127.0.0.1:<port>
// In this container WebKit also needs __EGL_VENDOR_LIBRARY_DIRS and LIBGL_DRIVERS_PATH pointing at
// its unpacked Mesa, besides LD_LIBRARY_PATH. What it changes:
// - service workers blocked (the panel's push registration closes the page in
//   this headless WebKit), as bot-home-spacing.cjs already does in both engines;
// - WebKit's benign "ResizeObserver loop completed with undelivered
//   notifications" page error is not passed to the test's pageerror handlers
//   (fires on the pristine checkout too; Chromium does not report it), nor
//   WebKit's "Fetch API cannot load ... due to access control checks", its
//   wording for a fetch cut off by page.goto (also on the pristine checkout).
const pw = require('/usr/local/lib/node_modules/playwright');
const webkit = pw.webkit;
const quiet = page => { const on = page.on.bind(page); page.on = (ev, fn) => ev === 'pageerror' ? on(ev, e => { if (/ResizeObserver loop completed|Fetch API cannot load [^]*? due to access control checks/.test(String(e.stack || '') + ' ' + String(e.message || ''))) return; fn(e); }) : on(ev, fn); return page; };
const patchContext = c => { const np = c.newPage.bind(c); c.newPage = async () => quiet(await np()); return c; };
const patch = b => { const nc = b.newContext.bind(b); b.newContext = async (o = {}) => patchContext(await nc({ ...o, serviceWorkers: 'block' })); b.newPage = async (o = {}) => (await b.newContext(o)).newPage(); return b; };
const proxy = new Proxy(webkit, { get(t, k) { if (k === 'launch') return async (o = {}) => { const { args, ...rest } = o; return patch(await t.launch(rest)); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
Object.defineProperty(pw, 'chromium', { value: proxy, configurable: true, writable: true });
if (pw.chromium !== proxy) throw new Error('shim failed');
