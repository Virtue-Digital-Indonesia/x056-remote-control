// Run the fixture with X056_TEST_STORAGE=1 first, then:
//   node test/browser/storage-sweeper.cjs [base URL]
// Settings > Storage: last runs, the manifest grouped by rule with
// select-all, "Approve selected" -> confirm with the total -> the passkey
// (Chromium's virtual authenticator holding the fixture's test-only key) ->
// only the selected item is deleted. Also: an agent-shaped call and an
// approval without a passkey are refused. SHOT=<file> saves a screenshot.
const assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const key = require('./storage-passkey.cjs');

// WebAuthn needs a domain, not an IP: same server, called localhost.
const base = (process.argv[2] || 'http://127.0.0.1:8768').replace('127.0.0.1', 'localhost');
const TOKEN = 'browser-fixture-token-0123456789';
const api = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) });

(async () => {
  const before = await (await api('/api/storage/manifest')).json();
  assert.ok(before.manifest, 'the fixture made a manifest');
  const nm = before.manifest.items.filter((i) => i.rule === 'M1');
  assert.equal(nm.length, 2, 'two node_modules wait for approval');
  const body = { manifestId: before.manifest.id, digest: before.manifest.digest, itemIds: [nm[0].id] };
  // Refused: the MCP bridge's identity, and a step 2 with no passkey.
  assert.equal((await api('/api/storage/approve/options', { ...body, from: 'some-session' })).status, 403);
  assert.equal((await api('/api/storage/approve', { ...body, flowId: 'x', response: { id: key.credentialId, response: {} } })).status, 403);

  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Jakarta' });
    await context.addInitScript((t) => localStorage.setItem('x056_token', t), TOKEN);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: Buffer.from(key.credentialId, 'base64url').toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: key.pkcs8, signCount: 0 } });

    await page.goto(base + '/settings/storage');
    await page.waitForSelector('#storageSettings fieldset[data-rule=M1]');
    // Last runs, the grouped manifest, approve disabled until something is picked.
    assert.match(await page.locator('#storageSettings .storage-run').first().innerText(), /Dry run/);
    const groups = await page.locator('#storageSettings fieldset.storage-group').evaluateAll((f) => f.map((x) => x.dataset.rule));
    assert.deepEqual(groups, ['M1', 'M2']);
    assert.equal(await page.locator('#storageApprove').isDisabled(), true);
    assert.equal(await page.locator('#storageProtected').getAttribute('open'), null, 'protected list starts collapsed');
    // Select-all picks the whole group; unpick one.
    await page.locator('[data-storage-all=M1]').check();
    assert.equal(await page.locator('fieldset[data-rule=M1] [data-storage-item]:checked').count(), 2);
    assert.match(await page.locator('#storageSelected').innerText(), /^2 selected/);
    await page.locator(`[data-storage-item="${nm[1].id}"]`).uncheck();
    assert.equal(await page.locator('[data-storage-all=M1]').evaluate((b) => b.indeterminate), true);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
    await page.locator('#storageApprove').click();
    // The confirm dialog names the count and the total.
    const dialog = page.locator('dialog[open]');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Delete 1 item\?/);
    assert.match(await dialog.innerText(), /About \d+(\.\d)? KB/);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.waitForFunction(() => /run finished: 1 deleted/.test(document.getElementById('storageStatus')?.textContent || ''), null, { timeout: 30000 });
    const after = await (await api('/api/storage')).json();
    assert.equal(after.runs[0].mode, 'approved');
    assert.equal(after.runs[0].deleted, 1);
    const receipts = await (await api('/api/storage/runs/' + after.runs[0].runId)).json();
    assert.deepEqual(receipts.receipts.map((r) => [r.target, r.result]), [[nm[0].target, 'deleted']]);
    // The approved item is gone from the list; the other one still waits.
    assert.equal(await page.locator(`[data-storage-item="${nm[0].id}"]`).count(), 0);
    assert.equal(await page.locator(`[data-storage-item="${nm[1].id}"]`).count(), 1);
    assert.deepEqual(errors, []);
    console.log('storage-sweeper: ok');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
