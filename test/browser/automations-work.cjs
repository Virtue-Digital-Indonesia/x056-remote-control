const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8795';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => {
      localStorage.setItem('x056_token', 'browser-fixture-token-0123456789');
      localStorage.setItem('x056_display_preferences', JSON.stringify({ open: 'side', maximize: 'modal' }));
    });
    const headers = { Authorization: 'Bearer browser-fixture-token-0123456789' };
    const api = async (path, data) => {
      const r = await context.request[data ? 'post' : 'get'](base + '/api/' + path, { headers, ...(data ? { data } : {}) });
      assert(r.ok(), await r.text()); return r.json();
    };
    assert.equal((await context.request.get(base + '/api/automations/session-timers')).status(), 401);
    const { projects } = await api('projects');
    const project = projects.find(p => p.name === 'Website refresh'), conversation = project.conversations[0];
    const codexProject = projects.find(p => p.name === 'Research workspace'), codexConversation = codexProject.conversations.find(c => c.provider === 'codex');
    const timers = await api('automations/session-timers');
    assert.equal(timers.jobs.length, 1);
    assert.equal(timers.jobs[0].sessionId, conversation.sessionId);
    assert.equal(timers.jobs[0].status, 'unverified');
    // Discovery must never create a duplicate executable job.
    assert.equal((await api('cron')).jobs.length, 0);
    const planned = await api('queue', { projectId: project.id, sessionId: conversation.sessionId, prompt: 'A future queued task', notBefore: Date.now() + 86400000, paused: true });
    const codexQueued = await api('queue', { projectId: codexProject.id, sessionId: codexConversation.sessionId, prompt: 'A future Codex task', notBefore: Date.now() + 86400000, paused: true });
    const codexSchedule = await api('cron', { projectId: codexProject.id, sessionId: codexConversation.sessionId, prompt: 'Scheduled Codex follow-up', schedule: '0 12 1 1 *', tz: 'Asia/Jakarta', once: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.locator('#crAutomationsTab').click();
    const job = page.locator('[data-session-timer="578ed466"]');
    await job.waitFor();
    assert.match(await job.innerText(), /Unverified/);
    assert.match(await job.innerText(), /CLI timezone unverified/);
    assert.match(await job.innerText(), /Build the new homepage/);
    assert.match(await job.innerText(), /Website refresh/);
    await job.locator('summary').click();
    assert.match(await job.locator('.automation-timer-prompt').innerText(), /19:00 WIB/);
    const queued = page.locator('[data-planned="' + planned.id + '"]');
    await queued.waitFor();
    assert.match(await queued.innerText(), /Paused.*Scheduled/);
    assert.equal(await queued.locator('.automation-provider').innerText(), 'Claude');
    const codexRow = page.locator('[data-planned="' + codexQueued.id + '"]');
    await codexRow.waitFor();
    assert.equal(await codexRow.locator('.automation-provider').innerText(), 'ChatGPT / Codex');
    const cronRow = page.locator('[data-cron-id="' + codexSchedule.id + '"]');
    await cronRow.waitFor();
    assert.equal(await cronRow.locator('.automation-provider').innerText(), 'ChatGPT / Codex');
    assert.equal(await cronRow.locator('.automation-cron-identity strong').innerText(), codexConversation.title);
    assert.equal(await cronRow.locator('.automation-cron-identity small').innerText(), codexProject.name);
    await cronRow.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.locator('[data-cron-id="' + codexSchedule.id + '"] button').filter({ hasText: 'Resume' }).waitFor();
    assert.equal((await api('cron')).jobs.find(j => j.id === codexSchedule.id).enabled, false);
    await page.locator('[data-cron-id="' + codexSchedule.id + '"]').getByRole('button', { name: 'Resume', exact: true }).click();
    await page.locator('[data-cron-id="' + codexSchedule.id + '"] button').filter({ hasText: 'Pause' }).waitFor();
    await page.screenshot({ path: '/tmp/automations-work.png', fullPage: true });
    await queued.getByRole('button', { name: 'Manage queue' }).click();
    await page.locator('#plannerItems [data-queue="' + planned.id + '"]').waitFor();
    assert.equal(await page.locator('#plannerProject').inputValue(), project.id);
    await api('queue/remove', { projectId: project.id, id: planned.id });
    await api('queue/remove', { projectId: codexProject.id, id: codexQueued.id });
    await api('cron/remove', { id: codexSchedule.id });
    await page.locator('#crAutomationsTab').click();
    await page.waitForFunction(() => document.querySelector('#automationQueue').textContent.includes('No planned or queued messages'));
    // Each source fails independently; unsupported backends get an explicit notice.
    await page.route('**/api/automations/session-timers', r => r.fulfill({ status: 404, body: '{}' }));
    await page.locator('#refreshAutomations').click();
    await page.waitForFunction(() => document.querySelector('#automationSessionTimers').textContent.includes('next backend release'));
    assert.match(await page.locator('#automationQueue').innerText(), /No planned or queued messages/);
    assert.deepEqual(errors, []);
    console.log('Automations shows Claude timers and both providers’ queues and schedules; Codex pause/resume and provider labels passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
