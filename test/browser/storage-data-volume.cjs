// Run the fixture with X056_TEST_STORAGE=volumes first, then:
//   node test/browser/storage-data-volume.cjs [base URL]
// Settings > Storage with a database volume in the manifest: it wears a
// "Data volume" tag, says so once, and the group's select-all skips it (the
// group says "data volumes excluded"). Ticked on its own row it goes into the
// approval request with exactly the ticked ids. A recognised cache volume does
// not claim it "may hold data".
const assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }

const base = process.argv[2] || 'http://127.0.0.1:8768';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
  const manifest = (await (await fetch(base + '/api/storage/manifest', { headers: { Authorization: 'Bearer ' + TOKEN } })).json()).manifest;
  assert.ok(manifest, 'the fixture seeded a manifest (X056_TEST_STORAGE=volumes)');
  const byTarget = Object.fromEntries(manifest.items.map((i) => [i.target, i]));
  const db = byTarget['docker:volume:ocr-pp-lab_db'], cache = byTarget['docker:volume:obs-gocache'];
  const nm = manifest.items.find((i) => i.rule === 'M1');
  assert.ok(db && cache && nm);

  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: 'Asia/Jakarta' });
    await context.addInitScript((t) => localStorage.setItem('x056_token', t), TOKEN);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const approvals = [];
    await page.route('**/api/storage/approve/options', async (route) => {
      approvals.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'stopped by the test' }) });
    });
    await page.goto(base + '/settings/storage');
    await page.waitForSelector('#storageSettings fieldset[data-rule=M4]');
    const row = (i) => page.locator('#storageSettings label.storage-item').filter({ has: page.locator(`[data-storage-item="${i.id}"]`) });
    const box = (i) => page.locator(`[data-storage-item="${i.id}"]`);

    // The tag is on the database row only, beside its name, and visible.
    assert.equal(await page.locator('#storageSettings .storage-tag').count(), 1);
    const tag = row(db).locator('strong .storage-tag');
    assert.equal(await tag.isVisible(), true);
    assert.equal((await tag.innerText()).trim(), 'Data volume');
    const tagStyle = await tag.evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor }; });
    assert.notEqual(tagStyle.bg, 'rgba(0, 0, 0, 0)', 'the tag has a background');
    assert.notEqual(tagStyle.color, tagStyle.bg);
    // Said once: no trailing "· data volume"; the cache does not "may hold data".
    const dbText = await row(db).locator('small').innerText();
    assert.doesNotMatch(dbText, /·\s*data volume/i, dbText);
    assert.match(dbText, /looks like a data volume \(db\)/);
    const cacheText = await row(cache).locator('small').innerText();
    assert.doesNotMatch(cacheText, /may (still )?hold data/, cacheText);
    assert.match(cacheText, /looks like a build cache \(gocache\)/);
    assert.match(await box(db).getAttribute('aria-label'), /data volume/);

    // Group select-all ticks the cache but never the database volume.
    const note = page.locator('fieldset[data-rule=M4] .storage-group-note');
    assert.equal(await note.isVisible(), false);
    await page.locator('[data-storage-all=M4]').check();
    assert.equal(await box(cache).isChecked(), true);
    assert.equal(await box(db).isChecked(), false);
    assert.equal(await page.locator('[data-storage-all=M4]').isChecked(), true);
    assert.equal(await note.isVisible(), true);
    assert.equal((await note.innerText()).trim(), '1 of 2 selected, data volumes excluded');
    assert.match(await page.locator('#storageSelected').innerText(), /^1 selected/);

    // Ticked on its own row, it is selected and the note goes.
    await box(db).check();
    assert.equal(await box(db).isChecked(), true);
    assert.equal(await note.isVisible(), false);
    assert.match(await page.locator('#storageSelected').innerText(), /^2 selected/);

    // Unticking the group clears it, the data volume included.
    await page.locator('[data-storage-all=M4]').uncheck();
    assert.equal(await box(db).isChecked(), false);
    assert.equal(await box(cache).isChecked(), false);

    // The approval asks for exactly the ticked ids: the data volume and the node_modules.
    await box(db).check();
    await box(nm).check();
    await page.locator('#storageApprove').click();
    const dialog = page.locator('dialog[open]');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Delete 2 items\?/);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await page.waitForFunction(() => /stopped by the test/.test(document.getElementById('storageStatus')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    assert.equal(approvals.length, 1, 'one approval request');
    assert.deepEqual([...approvals[0].itemIds].sort(), [db.id, nm.id].sort());
    assert.deepEqual(errors, []);
    console.log('storage-data-volume: ok');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
