// Production pane renderer + panel CSS, isolated from accounts and the server.
// Run: node test/browser/agent-tree-overflow.cjs [chromium|webkit]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let pw; try { pw = require('playwright'); } catch { pw = require('/usr/local/lib/node_modules/playwright'); }
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(process.env.X056_TEST_PANEL || path.join(root, 'server/public/panel.html'), 'utf8');
const sprite = html.match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(x => x[1]).join('\n');
(async () => {
  const browser = await pw[process.argv[2] || 'chromium'].launch({ headless: true, args: process.argv[2] === 'webkit' ? [] : ['--no-sandbox'] });
  try {
    for (const width of [320, 375, 378, 420, 560, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600 });
      const page = await context.newPage();
      await page.setContent('<html data-theme="dark"><head></head><body>' + sprite + '<main id="conversationSurface"></main></body></html>');
      await page.addStyleTag({ content: styles + '\nhtml,body {margin:0;width:100%;height:100%} #conversationSurface {position:relative;display:flex;justify-content:flex-end;width:100%;height:900px;margin:0;min-width:0;padding:0} #agentPane {box-sizing:border-box}' });
      await page.addScriptTag({ path: path.join(root, 'server/public/agent-tree.js') });
      await page.evaluate(() => {
        const now = Date.now();
        const engine = { costLabel: c => c ? '≈$' + c.usd.toFixed(2) : '' };
        window.fixturePane = createAgentPane({ engine, onClose: () => fixturePane.hide(), onExpand: () => {} });
        fixturePane.show();
        fixturePane.update({ tree: { provider: 'codex', helpers: { team: true }, team: { model: 'gpt-6-astra', effort: 'medium', pickedBy: 'jev', confidence: .57 }, main: { model: 'gpt-6-astra', effort: 'xhigh', running: false, lastTurn: { steps: 7, durationMs: 133000, costUsd: 1.87 } }, turns: [{ n: 31, startedAt: new Date(now - 240000).toISOString() }] }, subs: [
          { agentId: 'worker', agentType: 'codex-subagent', task: 'Locate activity checks', status: 'done', model: 'gpt-6-astra', effort: 'medium', startedAt: now - 200000, endedAt: now - 93000, usage: { input: 639000, output: 100 }, cost: { usd: 1234.56 } },
          { agentId: 'nested', parentAgentId: 'worker', agentType: 'codex-subagent', task: 'Release status', status: 'done', model: 'gpt-6-astra', effort: 'xhigh', startedAt: now - 150000, endedAt: now - 101000, usage: { input: 117000, output: 100 }, cost: { usd: .35 } },
        ] });
      });
      const team = page.locator('.ap-row[data-key="team"]');
      await team.focus(); await page.keyboard.press('ArrowLeft');
      assert.equal(await team.getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('ArrowRight');
      assert.equal(await team.getAttribute('aria-expanded'), 'true');
      // Pointer/touch folding still targets the same tree row.
      if (width < 600) { await team.tap(); await team.tap(); }
      const result = await page.evaluate(() => {
        const pane = document.getElementById('agentPane'), outline = document.getElementById('agentPaneOutline');
        const outside = [...pane.querySelectorAll('.ap-bits, .ap-brief, .ap-head button')].filter(e => {
          const r = e.getBoundingClientRect(), p = pane.getBoundingClientRect();
          return r.left < p.left - 1 || r.right > p.right + 1 || e.scrollWidth > e.clientWidth + 1;
        }).map(e => e.textContent || e.getAttribute('aria-label'));
        // Check actual text fragments, not only their wrapping container.
        for (const e of pane.querySelectorAll('.ap-bits')) {
          const range = document.createRange(); range.selectNodeContents(e);
          const p = pane.getBoundingClientRect();
          if ([...range.getClientRects()].some(r => r.left < p.left - 1 || r.right > p.right + 1)) outside.push(e.textContent);
        }
        return { outside, pane: [pane.clientWidth, pane.scrollWidth], outline: [outline.clientWidth, outline.scrollWidth], costs: [...pane.querySelectorAll('.ap-bits')].map(e => e.textContent) };
      });
      assert.deepEqual(result.outside, [], 'visible metadata and controls at ' + width);
      assert.ok(result.pane[1] <= result.pane[0] + 1 && result.outline[1] <= result.outline[0] + 1, 'no horizontal scrolling: ' + JSON.stringify(result));
      assert.ok(result.costs.some(x => x.includes('≈$1234.56')) && result.costs.some(x => x.includes('≈$0.35')), 'all costs retained');
      await page.locator('#agentPane').screenshot({ path: '/tmp/agent-tree-overflow-' + width + '.png' });
      console.log('PASS agent tree metadata, keyboard, touch and overflow at ' + width + 'px');
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
