// Start fixture.ts with X056_TEST_ASK_BATCH=1: every fake reply then ends with a
// two-question ASK block, so the gateway emits a LIVE multi-question event.
const assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const userBubbles = (text) => page.locator('#chat .msg.user').filter({ hasText: text }).count();
  const open = async (title) => {
    if (await page.locator('#chatClose').isVisible().catch(() => false)) await page.locator('#chatClose').click();
    await page.locator('.cr-task').filter({ hasText: title }).first().click();
    await page.waitForFunction(() => !document.getElementById('conversationSurface').hidden);
    await page.waitForTimeout(600);
  };

  await page.goto(base);
  await page.waitForSelector('.cr-task');
  await open('Build the new homepage');

  // 1. A single-choice answer shows ONCE. The panel appended its own untagged
  //    bubble and the server's session_started echo appended another.
  await page.locator('.qcard.pending .qopt').filter({ hasText: 'Main page' }).click();
  await page.locator('.qcard.pending .qbatch').waitFor({ timeout: 15000 }); // turn done, live batch question arrived
  await page.waitForTimeout(500);
  assert.equal(await userBubbles('Main page'), 1, 'a single-choice answer must render exactly one user bubble');

  // 2. Leaving and coming back must keep the multi-question form. The live
  //    event's copy lost `questions`, so re-rendering fell back to one question.
  await open('Review accessibility findings');
  await open('Build the new homepage');
  await page.locator('.qcard.pending').waitFor();
  assert.equal(await page.locator('.qcard.pending .qbatch fieldset').count(), 2, 'the reopened card must still be the multi-question form');
  assert.equal(await page.locator('.qcard.pending .qopt').count(), 0, 'the old single-question card must not replace it');

  // 3. A multi-question answer shows ONCE too.
  await page.locator('.qcard.pending label').filter({ hasText: 'Blue' }).click();
  await page.locator('.qcard.pending label').filter({ hasText: 'Large' }).click();
  const sent = page.waitForResponse((r) => r.url().includes('/api/sessions/current/messages') && r.request().method() === 'POST');
  await page.locator('.qcard.pending .qbatch button[type=submit]').click();
  assert.equal((await sent).status() < 300, true, 'the batch answer must be accepted');
  await page.waitForTimeout(2500); // let session_started and the turn land
  assert.equal(await userBubbles('Which colour should the header use?'), 1, 'a batch answer must render exactly one user bubble');

  // 4. An owner message that is not an answer leaves the card open, live and on the server. The turn above
  //    ended with the same two-question ASK, so a card is up again.
  await page.locator('.qcard.pending .qbatch').waitFor({ timeout: 15000 });
  const questionsNow = async () => (await (await page.request.get(base + '/api/questions', { headers: { Authorization: 'Bearer browser-fixture-token-0123456789' } })).json()).length;
  const openBefore = await questionsNow();
  assert.ok(openBefore >= 1, 'the server holds the open card');
  await page.locator('#prompt').fill('Unrelated: change the footer email to contact@example.com');
  const freeSent = page.waitForResponse((r) => /\/api\/(sessions\/current\/messages|steer|queue)/.test(r.url()) && r.request().method() === 'POST');
  await page.locator('#prompt').press('Enter');
  assert.equal((await freeSent).status() < 300, true, 'the free-text message must be accepted');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.qcard.pending').count(), 1, 'the card stays visible while the free-text turn runs');
  await page.waitForTimeout(2500); // the turn ends (re-asking the same questions: merged, nothing new)
  assert.equal(await page.locator('.qcard.pending').count(), 1, 'the card stays visible after the free-text turn');
  assert.equal(await questionsNow(), openBefore, 'the server still holds the card');

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS question answers render once; the multi-question card survives leaving and reopening the conversation; an owner free-text message leaves the card open');
})().catch((e) => { console.error(e); process.exit(1); });
