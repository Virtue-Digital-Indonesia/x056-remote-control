const assert = require('node:assert/strict');
const { appendFileSync, mkdirSync, writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() =>
    localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'),
  );
  const headers = {
    Authorization: 'Bearer browser-fixture-token-0123456789',
    'Content-Type': 'application/json',
  };
  const response = await context.request.get(base + '/api/projects', {
    headers,
  });
  const project = (await response.json()).projects.find((p) => p.name === 'Website refresh');
  assert.ok(project.cwd.startsWith('/tmp/x056-browser-'), 'Use an isolated local browser fixture');
  const sid = project.conversations[0].sessionId,
    path = join(project.cwd, 'browser draft.png');
  writeFileSync(
    path,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1kAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const dir = join(project.cwd, 'primary', 'projects', 'fixture');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, sid + '.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: path } },
          {
            type: 'text',
            text: '[Missing temporary screenshot](' + project.cwd + '/gone.png)',
          },
        ],
      },
    }) + '\n',
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('.cr-task').filter({ hasText: project.conversations[0].title }).first().click();
  await page.locator('#chatResults').click();
  await page.locator('[data-result-kind=image]').click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.results-dialog .artifact-image img')].some(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  await page.locator('[data-results-warnings] summary').click();
  await page.locator('[data-results-warnings]').filter({ hasText: '/gone.png' }).waitFor();
  await page.screenshot({ path: '/tmp/artifacts-results.png' });
  unlinkSync(path);
  await page.locator('.results-dialog [data-view]').first().click();
  await page.waitForFunction(() => {
    const img = document.querySelector('.artifact-large');
    return img?.complete && img.naturalWidth > 0;
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('#chatClose').click();
  await page.locator('#crArtifactsTab').click();
  await page.locator('#artifactSearch').fill('browser draft');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#artifactItems .artifact-image img')].some(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'Conversation PNG scan, missing-file feedback, retained image viewer and artifact library thumbnails passed.',
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
