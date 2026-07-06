#!/usr/bin/env node
// Headless-browser screenshot helper for sessions running inside the container.
// Usage: node /app/scripts/shot.cjs <url> [out.png] [width] [height] [--wait ms]
// Resolves the globally-installed Playwright by absolute path so it works from
// any cwd; launches Chromium with --no-sandbox (required in the container).
const path = process.argv[2];
if (!path) {
  console.error('usage: node /app/scripts/shot.cjs <url> [out.png] [width] [height]');
  process.exit(2);
}
const out = process.argv[3] || 'shot.png';
const width = Number(process.argv[4]) || 1280;
const height = Number(process.argv[5]) || 800;

let chromium;
for (const p of ['/usr/local/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(p)); break; } catch (e) { /* try next */ }
}
if (!chromium) {
  console.error('playwright not found — is the image built with it? (rebuild needed)');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(path, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
      // fall back to a plain load if the page never goes idle (SPAs with polling)
    });
    await page.screenshot({ path: out, fullPage: true });
    console.log('wrote', out);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('screenshot failed:', e.message); process.exit(1); });
