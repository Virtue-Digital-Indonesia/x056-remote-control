const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  async function open(mobile = false) {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
    const page = await context.newPage();
    await page.goto(base);
    await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
    return { context, page, prompt: page.locator('#prompt') };
  }
  const { context, page, prompt } = await open();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const [initial, expected] of [
    ['-', '-\n- '], ['1.', '1.\n2. '], ['- First', '- First\n- '], ['* First', '* First\n* '], ['+ First', '+ First\n+ '],
    ['1. First', '1. First\n2. '], ['9) Ninth', '9) Ninth\n10) '], ['009. Ninth', '009. Ninth\n010. '],
    ['  - Nested', '  - Nested\n  - '], ['\t3. Nested', '\t3. Nested\n\t4. '],
    ['Plain text', 'Plain text\n'], ['---', '---\n'], ['-no space', '-no space\n'],
    ['```sh\n- literal', '```sh\n- literal\n'], ['~~~\n1. literal', '~~~\n1. literal\n'],
    ['```\nexample\n```\n- First', '```\nexample\n```\n- First\n- ']
  ]) {
    await prompt.fill(initial); await prompt.press('Shift+Enter');
    assert.equal(await prompt.inputValue(), expected, initial);
  }
  for (const initial of ['-', '1.', '- First', '1. First', '  * Nested']) {
    await prompt.fill(initial); await prompt.press('Shift+Enter'); await prompt.press('Shift+Enter');
    assert.equal(await prompt.inputValue(), initial + '\n');
    await prompt.press('Control+z');
    assert.match(await prompt.inputValue(), /(?:[-*]|2\.) $/, 'Undo restores removed marker');
  }
  await prompt.fill('- First'); await prompt.press('Shift+Enter'); await prompt.press('Control+z');
  assert.equal(await prompt.inputValue(), '- First', 'Undo removes generated newline and marker together');
  await prompt.fill('- hello world\n- later');
  await prompt.evaluate(el => el.setSelectionRange(7, 7)); await prompt.press('Shift+Enter');
  assert.equal(await prompt.inputValue(), '- hello\n-  world\n- later');
  assert.equal(await prompt.evaluate(el => el.selectionStart), 10);
  await prompt.fill('- delete this'); await prompt.evaluate(el => el.setSelectionRange(9, 13)); await prompt.press('Shift+Enter');
  assert.equal(await prompt.inputValue(), '- delete \n- ');
  await prompt.fill('- First');
  await prompt.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak', isComposing: true })));
  assert.equal(await prompt.inputValue(), '- First', 'IME input is untouched');
  await prompt.press('Shift+Enter');
  await page.reload(); await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  assert.equal(await prompt.inputValue(), '- First\n- ', 'Generated marker is saved in the conversation draft');
  let request;
  await page.route('**/api/sessions/current/messages', route => { request = route.request().postDataJSON(); return route.fulfill({ status: 409, json: { message: 'Fixture captured send' } }); });
  await prompt.fill('- Send normally'); await prompt.press('Enter');
  while (!request) await page.waitForTimeout(20);
  assert.equal(request.prompt, '- Send normally', 'Desktop Enter still sends');
  assert.deepEqual(errors, []);
  await context.close();
  const mobile = await open(true);
  await mobile.prompt.fill('1. Mobile'); await mobile.prompt.press('Enter');
  assert.equal(await mobile.prompt.inputValue(), '1. Mobile\n2. ');
  await mobile.prompt.press('Enter'); assert.equal(await mobile.prompt.inputValue(), '1. Mobile\n');
  await mobile.prompt.fill('- Mobile');
  await mobile.prompt.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' })));
  assert.equal(await mobile.prompt.inputValue(), '- Mobile\n- ');
  await mobile.context.close(); await browser.close();
  console.log('PASS: bullets, numbered lists, indentation, empty-item exit, undo, caret edits, code fences, drafts, IME, desktop send and mobile Return.');
})().catch(e => { console.error(e); process.exit(1); });
