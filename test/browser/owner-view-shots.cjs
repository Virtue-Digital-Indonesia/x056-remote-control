// Review screenshots of owner view in a NORMAL conversation: the owner's own turn, a Bot relay ("no action needed, no
// reply needed") and the AI's reply hidden behind one button, an agent turn marked for the owner shown whole, another
// hidden run. Default view and with the hidden messages shown; 1440x900, 1920x1080, iPhone 13, and 1440 dark. Chromium.
//   X056_SHOTS=/tmp/owner-view-shots node test/browser/owner-view-shots.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
const shots = process.env.X056_SHOTS || '/tmp/owner-view-shots';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
fs.mkdirSync(shots, { recursive: true });

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  try {
    const admin = await browser.newContext();
    const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: 'Staging deploy', provider: 'claude' } });
    assert.ok(r.ok(), await r.text());
    const chat = await r.json(); await admin.close();
    const t = s => new Date(Date.now() - s * 1000).toISOString();
    const bot = { kind: 'conversation', conversationTitle: 'Bot', projectName: 'Bot', messageId: 'bot-relay-1', sessionId: 'bot-session' };
    const deploy = { kind: 'conversation', conversationTitle: 'Valid Deployment', projectName: 'obscura', messageId: 'deploy-1', sessionId: 'deploy-session' };
    const cron = { kind: 'automation', conversationTitle: 'Nightly check', projectName: 'obscura', messageId: 'cron-1' };
    const rows = [
      { role: 'user', text: 'Why did the staging deploy fail last night? Fix it if it is small.', ts: t(3600) },
      { role: 'action', text: 'Used Bash', detail: 'kubectl logs deploy/api --tail=80', ts: t(3590) },
      { role: 'assistant', text: 'The migration `20261021_add_index` timed out on staging. I raised the lock timeout to 30 s and re-ran it: staging is green again.\n\nThe cause was a long-running report holding a lock; I left that alone.', ts: t(3500) },
      { role: 'user', text: 'Efran asked me to keep him posted on staging. FYI only: the migration is fixed. No action needed, no reply needed.', ts: t(3000), messageId: 'bot-relay-1', sender: bot, ownerView: 'show' },
      { role: 'assistant', text: 'Noted. Nothing to do on my side; staging stays as it is.', ts: t(2990) },
      { role: 'user', text: 'Valid Deployment is asking whether the build is safe to promote to production.', ts: t(1800), messageId: 'deploy-1', sender: deploy, forOwner: true },
      { role: 'action', text: 'Used Bash', detail: 'npm run test:e2e', ts: t(1790) },
      { role: 'assistant', text: '**Ready to promote.** All 412 end-to-end tests pass on staging and the migration is in.\n\nIt needs your go-ahead: promote `v2026.10.22` to production?', ts: t(1700) },
      { role: 'user', text: 'Nightly check: staging health is ok, 0 errors in the last 6 hours.', ts: t(900), messageId: 'cron-1', sender: cron },
      { role: 'assistant', text: 'Recorded: healthy.', ts: t(890) },
      { role: 'user', text: 'Bot here again: still no action needed.', ts: t(600), messageId: 'bot-relay-2', sender: { ...bot, messageId: 'bot-relay-2' } },
      { role: 'assistant', text: 'Understood.', ts: t(590) },
    ];
    const cases = [
      ['desktop-1440', { viewport: { width: 1440, height: 900 } }],
      ['desktop-1920', { viewport: { width: 1920, height: 1080 } }],
      ['phone-390', { ...playwright.devices['iPhone 13'] }],
      ['desktop-1440-dark', { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }],
    ];
    const out = [];
    for (const [label, options] of cases) {
      const context = await browser.newContext({ serviceWorkers: 'block', ...options });
      await context.addInitScript(([tok, dark]) => { localStorage.setItem('x056_token', tok); if (dark) localStorage.setItem('x056_theme', 'dark'); }, [token, /dark/.test(label)]);
      await context.route(/\/api\/sessions\/current\/stream/, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
      await context.route('**/api/questions', route => route.fulfill({ json: [] }));
      await context.route(/\/api\/conversations\/history-page\?/, route => new URL(route.request().url()).searchParams.get('projectId') === chat.id ? route.fulfill({ json: { done: true, cursor: null, rows } }) : route.continue());
      const page = await context.newPage();
      await page.goto(base + '/chat/' + chat.id);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .ov-btn').first().waitFor();
      await page.waitForTimeout(700);
      const settleChip = () => page.waitForFunction(() => { const e = document.getElementById('streamStatus'); return !e || e.hidden || e.classList.contains('fade-out') || getComputedStyle(e).opacity === '0'; }, null, { timeout: 8000 }).then(() => page.waitForTimeout(600));
      const file = (name) => `${shots}/${label}-${name}.png`;
      await settleChip(); await page.screenshot({ path: file('default') }); out.push(file('default'));
      const composerState = () => page.evaluate(() => ({ open: !!document.querySelector('.composer-wrap')?.hasAttribute('data-qp-open'), focus: document.activeElement?.id || document.activeElement?.tagName }));
      const before = await composerState();
      await page.locator('#chat .ov-btn').first().click();
      await page.waitForTimeout(400);
      const after = await composerState();
      console.log(label, 'composer before Show', JSON.stringify(before), 'after Show', JSON.stringify(after));
      // Show moves focus to the pill's Hide (the control that undoes it), so the composer folds to its resting pill:
      // the quiet composer's own rule (open while it holds text, a file or a menu; focus alone never opens it). It is
      // not the owner view changing its shape.
      assert.equal(after.focus, 'rcOwnerHide', label + ': focus goes to Hide');
      // Shown at the bottom of the thread, where a reader is after reading: mid-scroll the panel's existing floating
      // jump and stage buttons sit over a bubble on a phone, which is not what this change adds.
      await page.evaluate(() => { const sc = document.querySelector('.scroll'); sc.scrollTop = sc.scrollHeight; }); await page.waitForTimeout(400);
      await settleChip(); await page.screenshot({ path: file('shown') }); out.push(file('shown'));
      if (label === 'desktop-1440') {
        await page.locator('#prompt').focus(); await page.waitForTimeout(400);
        const refocused = await composerState();
        assert.equal(refocused.open, before.open, label + ': with the prompt focused again the composer is as in the default view (focus alone keeps it quiet)');
        await page.screenshot({ path: file('shown-focused') }); out.push(file('shown-focused'));
        await page.locator('#rcOwnerHide').focus(); await page.waitForTimeout(300);
      }
      const box = async sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; }, sel);
      const lastRow = await page.evaluate(() => { const rows = [...document.querySelectorAll('#chat>*')].filter(e => getComputedStyle(e).display !== 'none'); const r = rows[rows.length - 1].getBoundingClientRect(); return { bottom: Math.round(r.bottom) }; });
      const pill = await box('#rcOwnerPill'), tools = await box('#rcChatControls'), input = await box('#composerBox');
      const stage = await page.evaluate(() => { const e = document.getElementById('conversationStage'); if (!e || getComputedStyle(e).display === 'none') return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; });
      console.log(label, JSON.stringify({ pill, tools, input, lastRow, stage }));
      assert.ok(pill && tools && pill.bottom <= tools.top, label + ': the pill is above the toolbar row');
      assert.ok(tools.bottom <= input.top, label + ': toolbar above the input');
      const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      assert.ok(!overlap(pill, stage), label + ': pill clear of the stage button');
      assert.ok(lastRow.bottom <= pill.top + 1, label + ': pill clear of the last chat row');
      if (/phone/.test(label)) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, 'no horizontal overflow at 390: ' + overflow);
      }
      await context.close();
    }
    {
      // The shown agent turn with its question card: the turn is shown because its reply asked (an ASK block, which
      // the server strips from the text and turns into the pending card) and the reply's marker is stripped by the panel.
      const qrows = rows.slice(0, 8).map(r => r.sender?.messageId === 'deploy-1' ? r : r);
      qrows[7] = { ...qrows[7], text: qrows[7].text + '\n\n<<<FOR_OWNER>>>' };
      const question = { projectId: chat.id, sessionId: chat.lastSessionId, question: 'Promote v2026.10.22 to production?', options: ['Promote now', 'Wait until tomorrow'], at: t(1700) };
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
      await context.addInitScript(tok => localStorage.setItem('x056_token', tok), token);
      await context.route(/\/api\/sessions\/current\/stream/, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
      await context.route('**/api/questions', route => route.fulfill({ json: [question] }));
      await context.route(/\/api\/conversations\/history-page\?/, route => new URL(route.request().url()).searchParams.get('projectId') === chat.id ? route.fulfill({ json: { done: true, cursor: null, rows: qrows } }) : route.continue());
      const page = await context.newPage();
      await page.goto(base + '/chat/' + chat.id);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .qcard.pending').waitFor();
      await page.waitForTimeout(700);
      await page.waitForFunction(() => { const e = document.getElementById('streamStatus'); return !e || e.hidden || e.classList.contains('fade-out') || getComputedStyle(e).opacity === '0'; }, null, { timeout: 8000 }).then(() => page.waitForTimeout(600));
      await page.evaluate(() => { const sc = document.querySelector('.scroll'); sc.scrollTop = sc.scrollHeight; }); await page.waitForTimeout(300);
      assert.ok(await page.locator('#chat .qcard.pending').isVisible(), 'the question card shows');
      assert.ok(await page.getByText('It needs your go-ahead', { exact: false }).isVisible(), 'the asking agent turn shows');
      const leaked = await page.evaluate(() => document.getElementById('chat').innerText.includes('<<<'));
      assert.equal(leaked, false, 'no <<<FOR_OWNER>>> / ASK text on screen');
      const f = `${shots}/desktop-1440-question.png`;
      await page.screenshot({ path: f }); out.push(f);
      await context.close();
    }
    console.log('SHOTS', out.join('\n'));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
