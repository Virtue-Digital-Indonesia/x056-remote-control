const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8767';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  async function open(mobile = false) {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
    const page = await context.newPage(); await page.goto(base);
    await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
    return { context, page, prompt: page.locator('#prompt') };
  }
  const { context, page, prompt } = await open();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const [initial, expected] of [
    ['-', '  • \n  • '], ['1.', '  1. \n  2. '], ['- First', '  • First\n  • '], ['* First', '  • First\n  • '], ['+ First', '  • First\n  • '],
    ['1. First', '  1. First\n  2. '], ['9) Ninth', '  9) Ninth\n  10) '], ['009. Ninth', '  009. Ninth\n  010. '],
    ['  - Nested', '    • Nested\n    • '],
    ['Plain text', 'Plain text\n'], ['---', '---\n'], ['-no space', '-no space\n'],
    ['```sh\n- literal', '```sh\n- literal\n'], ['~~~\n1. literal', '~~~\n1. literal\n'],
    ['```\nexample\n```\n- First', '```\nexample\n```\n  • First\n  • ']
  ]) {
    await prompt.fill(initial); await prompt.press('Shift+Enter'); assert.equal(await prompt.inputValue(), expected, initial);
  }
  for (const initial of ['  • First', '  1. First', '    • Nested']) {
    await prompt.fill(initial); await prompt.press('Shift+Enter'); await prompt.press('Shift+Enter');
    assert.equal(await prompt.inputValue(), initial + '\n');
    assert.equal(await prompt.evaluate(el => el.selectionStart), initial.length + 1, 'Caret stays on the blank line');
    await prompt.press('Control+z'); assert.match(await prompt.inputValue(), /(?:•|2\.) $/, 'Undo restores removed marker');
    await prompt.press('Shift+Enter'); await prompt.pressSequentially('Outside list');
    assert.equal(await prompt.inputValue(), initial + '\nOutside list', 'Typing after exit never snaps back onto the prior item');
  }
  await prompt.fill(''); await prompt.pressSequentially('- First');
  assert.equal(await prompt.inputValue(), '  • First', 'Typing dash-space creates a padded dot bullet');
  await prompt.press('Tab'); assert.equal(await prompt.inputValue(), '    • First');
  await prompt.press('Shift+Tab'); assert.equal(await prompt.inputValue(), '  • First');
  await prompt.press('Shift+Tab'); assert.equal(await prompt.inputValue(), 'First', 'Outdent at base level exits list');
  await prompt.fill(''); await prompt.press('Tab'); await prompt.pressSequentially('Created with Tab');
  assert.equal(await prompt.inputValue(), '  • Created with Tab');
  await prompt.fill(''); await prompt.pressSequentially('1. First');
  assert.equal(await prompt.inputValue(), '  1. First');
  await prompt.press('Tab'); await prompt.press('Shift+Enter');
  assert.equal(await prompt.inputValue(), '    1. First\n    2. ');
  await prompt.fill('  • First\n  • Second'); await prompt.selectText(); await prompt.press('Tab');
  assert.equal(await prompt.inputValue(), '    • First\n    • Second');
  await prompt.press('Shift+Tab'); assert.equal(await prompt.inputValue(), '  • First\n  • Second');
  await prompt.fill('  • First'); await prompt.press('Shift+Enter'); await prompt.press('Control+z');
  assert.equal(await prompt.inputValue(), '  • First', 'Undo removes generated newline and marker together');
  await prompt.fill('  • hello world\n  • later');
  await prompt.evaluate(el => el.setSelectionRange(9, 9)); await prompt.press('Shift+Enter');
  assert.equal(await prompt.inputValue(), '  • hello\n  •  world\n  • later');
  assert.equal(await prompt.evaluate(el => el.selectionStart), 14);
  await prompt.fill('');
  await prompt.evaluate(el => { const data = new DataTransfer(); data.setData('text/plain', '- Pasted\n  1. Nested number'); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
  assert.equal(await prompt.inputValue(), '  • Pasted\n    1. Nested number', 'Pasted Markdown keeps nesting');
  await prompt.fill('  • First\n    • Nested\n  1. Numbered');
  await page.reload(); await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
  assert.equal(await prompt.inputValue(), '  • First\n    • Nested\n  1. Numbered', 'Draft round trip preserves visible indentation');
  await page.waitForFunction(() => { const el = document.querySelector('#prompt'); return el.clientHeight >= el.scrollHeight; });
  await prompt.screenshot({ path: '/tmp/composer-list-indentation.png' });
  let request;
  await page.route('**/api/sessions/current/messages', route => { request = route.request().postDataJSON(); return route.fulfill({ status: 400, json: { message: 'Fixture captured send' } }); });
  await prompt.press('Enter');
  await page.waitForFunction(() => document.querySelector('#prompt').value.includes('First'));
  assert.equal(request.prompt, '- First\n  - Nested\n1. Numbered', 'Send serializes dots and base padding as Markdown');
  assert.equal(await prompt.inputValue(), '  • First\n    • Nested\n  1. Numbered', 'Failed send restores displayed list');
  assert.deepEqual(errors, []); await context.close();
  const mobile = await open(true);
  await mobile.prompt.fill('1. Mobile'); await mobile.prompt.press('Enter');
  assert.equal(await mobile.prompt.inputValue(), '  1. Mobile\n  2. ');
  await mobile.prompt.press('Enter'); await mobile.prompt.pressSequentially('Next paragraph');
  assert.equal(await mobile.prompt.inputValue(), '  1. Mobile\nNext paragraph');
  await mobile.prompt.fill('- Mobile');
  await mobile.prompt.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' })));
  assert.equal(await mobile.prompt.inputValue(), '  • Mobile\n  • ');
  await mobile.context.close(); await browser.close();
  console.log('PASS: dot bullets, base indentation, Tab/outdent/multiple lines, retained blank-line caret, undo, code fences, drafts, Markdown send/recovery, and mobile Return.');
})().catch(e => { console.error(e); process.exit(1); });
