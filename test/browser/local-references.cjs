const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const reference = '/tmp/x056-local-reference.csv';
fs.writeFileSync(reference, 'id,status\n1,ok\n');

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1120, height: 900 } });
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/conversations/history-page*', async (route) => {
    const response = await route.fetch(), data = await response.json();
    data.rows.push({
      role: 'assistant',
      text: 'Review [Exact results](' + reference + ':2), [documentation](https://example.test/docs), and [unsafe](javascript:alert(1)). [Relative template](' + retained + ') [Absolute template](' + base + retained + '). [Gateway artifact](' + artifactLink + ') [Artifact with extra query](' + artifactLink + '&x=1).',
      ts: new Date().toISOString(),
    });
    await route.fulfill({ response, json: data });
  });
  const retained = '/api/chats/chat-fixture/files/file-fixture/versions/version-fixture/download';
  // The URL list_artifacts/read_artifact hand the model as `downloadPath`.
  const artifactId = '80f664b1-a523-4178-85e0-4c84aa61c445', artifactLink = '/api/workspace/artifact-file?id=' + artifactId;
  let artifactRequests = 0;
  await page.route(url => url.pathname === '/api/workspace/artifact-file' && url.searchParams.get('id') === artifactId && [...url.searchParams.keys()].length === 1, async route => {
    assert.equal(route.request().headers().authorization, 'Bearer browser-fixture-token-0123456789');
    artifactRequests++;
    await route.fulfill({status:200, headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':"attachment; filename=\"Skripsi v0.23.docx\""},body:'artifact bytes'});
  });
  let retainedRequests = 0, referenceRequests = 0;
  await page.route('**' + retained, async route => {
    assert.equal(route.request().headers().authorization, 'Bearer browser-fixture-token-0123456789');
    retainedRequests++;
    await route.fulfill({status:200, headers:{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename=download; filename*=UTF-8''Template%20Invoice%20Valid.dotx"},body:'retained template bytes'});
  });
  page.on('request', r => { if (r.url().includes('/artifact-reference')) referenceRequests++; });
  await page.goto(base);
  await page.waitForSelector('.cr-task');
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  const ref = page.locator('.content .local-ref').filter({ hasText: 'Exact results' });
  await ref.waitFor();
  assert.equal(await ref.getAttribute('title'), reference + ':2');
  assert.equal(await page.locator('.content a[href="https://example.test/docs"]').count(), 1);
  assert.match(await page.locator('.msg.assistant').last().innerText(), /\[unsafe\]\(javascript:alert\(1\)\)/);
  await page.screenshot({ path: '/tmp/x056-local-references.png', animations: 'disabled' });

  const download = page.waitForEvent('download');
  await ref.click();
  assert.equal((await download).suggestedFilename(), 'x056-local-reference.csv');
  const localRequests = referenceRequests;
  for (const label of ['Relative template', 'Absolute template']) {
    const received = page.waitForEvent('download');
    await page.locator('.content .local-ref').filter({hasText:label}).click();
    const file = await received;
    assert.equal(file.suggestedFilename(), 'Template Invoice Valid.dotx');
    assert.equal(fs.readFileSync(await file.path(), 'utf8'), 'retained template bytes');
  }
  assert.equal(retainedRequests, 2);
  assert.equal(referenceRequests, localRequests, 'API links must not be resolved as filesystem paths');

  // Live bug: this link 400'd with "The original file is no longer available."
  const artifactDownload = page.waitForEvent('download');
  await page.locator('.content .local-ref').filter({hasText:'Gateway artifact'}).click();
  const artifactFile = await artifactDownload;
  assert.equal(artifactFile.suggestedFilename(), 'Skripsi v0.23.docx');
  assert.equal(fs.readFileSync(await artifactFile.path(), 'utf8'), 'artifact bytes');
  assert.equal(artifactRequests, 1);
  assert.equal(referenceRequests, localRequests, 'the artifact download URL must not be resolved as a filesystem path');
  // A second parameter makes it not ours: it must not be fetched as an artifact.
  const before = artifactRequests;
  await page.locator('.content .local-ref').filter({hasText:'Artifact with extra query'}).click();
  await page.waitForTimeout(400);
  assert.equal(artifactRequests, before);
  const projects = await (await context.request.get(base + '/api/projects', { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } })).json();
  const project = projects.projects.find((item) => item.name === 'Website refresh');
  const conversation = project.conversations.find((item) => item.title === 'Build the new homepage');
  const artifacts = await (await context.request.get(base + '/api/workspace/artifacts?projectId=' + encodeURIComponent(project.id) + '&sessionId=' + encodeURIComponent(conversation.sessionId), { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } })).json();
  assert.ok(artifacts.some((item) => item.original === reference && item.title === 'Exact results'));

  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await browser.close();
  fs.unlinkSync(reference);
  console.log('PASS local references render safely, download retained files and fit mobile');
})().catch((error) => { try { fs.unlinkSync(reference); } catch {} console.error(error); process.exit(1); });
