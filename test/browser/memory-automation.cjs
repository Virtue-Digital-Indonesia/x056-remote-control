// Starts its own disposable gateway; never targets a running operator instance.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const port = Number(process.env.X056_TEST_MEMORY_AUTOMATION_PORT || 8797);
const base = 'http://127.0.0.1:' + port;
const token = 'browser-fixture-token-0123456789';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const fixture = spawn(process.execPath, ['--import', 'tsx', 'test/browser/fixture.ts'], {
    detached: true,
    env: { ...process.env, X056_TEST_PORT: String(port), X056_CHAT_ENABLED: '0', X056_PROJECT_SPACES_ENABLED: '0', X056_TEST_CHAT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', browser;
  fixture.stdout.on('data', data => { output += data; });
  fixture.stderr.on('data', data => { output += data; });
  const stopped = new Promise(resolve => fixture.once('exit', resolve));
  const api = async body => {
    const response = await fetch(base + '/api/memory/settings', { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, 'fixture settings HTTP ' + response.status);
    return response.json();
  };
  try {
    // Require this newly spawned fixture's own startup marker before connecting.
    for (let n = 0; n < 180 && !output.includes('Browser fixture ready at '); n++) {
      if (fixture.exitCode !== null) throw new Error('Fixture exited: ' + output);
      await delay(200);
    }
    if (!output.includes('Browser fixture ready at ')) throw new Error('Fixture readiness marker missing: ' + output);
    await api({ autoManage: false, autoApproveConversationNotes: true });
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(value => localStorage.setItem('x056_token', value), token);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const openSettings = async () => {
      await page.locator('#crSettings').click();
      await page.locator('[data-settings="memory"]').click();
      await page.locator('#memoryAutomation').waitFor({ state: 'visible' });
    };
    await page.goto(base);
    await openSettings();
    assert.equal(await page.locator('#memoryAutomation').inputValue(), 'conversation');
    assert.deepEqual(await page.locator('#memoryAutomation option').allTextContents(), ['Review all', 'Save new conversation notes', 'Automatically manage memory']);
    for (const [mode, autoManage, autoApproveConversationNotes] of [['automatic', true, false], ['review', false, false], ['conversation', false, true]]) {
      const saved = page.waitForResponse(response => response.url().endsWith('/api/memory/settings') && response.request().method() === 'POST');
      await page.locator('#memoryAutomation').selectOption(mode);
      assert.ok((await saved).ok());
      await page.getByText('Saved.', { exact: true }).waitFor();
      const settings = await api();
      assert.equal(settings.autoManage, autoManage);
      assert.equal(settings.autoApproveConversationNotes, autoApproveConversationNotes);
      await page.reload();
      await openSettings();
      assert.equal(await page.locator('#memoryAutomation').inputValue(), mode);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: memory automation renders limited mode; full/manual/limited changes save correct flags, show Saved, and persist after reload.');
  } finally {
    if (browser) await browser.close();
    try { process.kill(-fixture.pid, 'SIGTERM'); } catch {}
    await Promise.race([stopped, delay(3000)]);
    try { process.kill(-fixture.pid, 'SIGKILL'); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
