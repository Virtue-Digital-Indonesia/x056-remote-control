/*
 * Agent tree: one conversation's working setup at a glance -- the main
 * session, its advisor, the Jev fork layer, the workers it delegated to (team
 * subagents and delegates), the way back to the main session, and a log of
 * what just passed between them.
 *
 * Takes the chat's place like the terminal view (the two are exclusive).
 * Reads GET /api/conversations/agent-tree (cheap) on open, on live events and
 * on a slow poll; reads the heavier subagent list only while open, only while
 * something runs (plus once on open), and never faster than every 5 s.
 */
(function () {
  'use strict';
  var FAST_MS = 3000, SLOW_MS = 15000, SUBS_MIN_MS = 5000, LOG_MAX = 15, FORKS_SHOWN = 4;
  var EVENTS = ['jev_fork', 'jev_decision', 'advisor_call', 'advisor_consult', 'delegate_update', 'delegate_report', 'turn_state', 'session_done'];
  var EFFORT_LEVEL = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
  var CHECKPOINTS = [['plan', 'before a plan'], ['stuck', 'error repeats'], ['done', 'before done']];
  var VERDICT = { proceed: 'proceed', adjust: 'adjust', looks_good: 'looks good', concern: 'concern' };
  var SUB_STATUS = { running: ['◐', 'running'], done: ['✓', 'done'], stopped: ['■', 'stopped'], failed: ['✕', 'failed'] };
  var DG_STATUS = { working: 'working', idle: 'idle', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
  var GATE = { done: 'done', needs_orchestrator: 'needs orchestrator', needs_human: 'needs you', blocked: 'blocked' };

  // ---- small helpers ---------------------------------------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  /** Appends and returns the CHILD (add() returns the parent). */
  function put(parent, child) { parent.appendChild(child); return child; }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  /** Subagent times are epoch ms, everything else ISO; both become ms. */
  function ms(v) { if (v == null || v === '') return NaN; if (typeof v === 'number') return v; var n = Date.parse(v); return n; }
  function clock(t) { if (!isFinite(t)) return '--:--:--'; var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function secs(v) { return v == null ? '' : v < 1000 ? v + ' ms' : (v / 1000).toFixed(v < 10000 ? 1 : 0) + ' s'; }
  function pct(c) { return c == null ? '' : Math.round(c * 100) + '%'; }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function one(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  /** "claude-opus-5-5" -> "Opus 5.5", "opus" -> "Opus", "gpt-6-astra" -> "GPT-6 Astra". */
  function modelName(m) {
    if (!m) return '';
    m = String(m).replace(/\[.*\]$/, '');
    var gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(m);
    if (gpt) return 'GPT-' + gpt[1] + (gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : '');
    var cl = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(m);
    if (cl) return cap(cl[1]) + ' ' + cl[2] + (cl[3] ? '.' + cl[3] : '');
    return m.split('-').map(cap).join(' ');
  }
  function effortBar(effort) {
    var lvl = EFFORT_LEVEL[effort] || 0, bar = el('span', 'at-effort');
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', 'effort ' + (effort || 'default'));
    for (var i = 1; i <= 4; i++) add(bar, el('i', i <= lvl ? 'on' : ''));
    return bar;
  }
  function row(cls, label, value) { var r = el('div', 'at-row ' + (cls || '')); add(r, el('span', 'k', label), value instanceof Node ? value : el('span', 'v', value)); return r; }

  window.createAgentTree = function (engine) {
    var main = document.querySelector('body > main');
    var root = document.createElement('section');
    root.id = 'atree'; root.className = 'term atree'; root.hidden = true; root.setAttribute('aria-label', 'Agent tree');
    var head = add(el('div', 'term-head'), el('strong', '', 'Agent tree'));
    var title = put(head, el('span', 'at-title')); title.id = 'atreeTitle';
    add(head, el('span', 'sp'));
    var live = put(head, el('span', 'term-live', '● live')); live.title = 'refreshes while open';
    var body = el('div', 'at-body'); body.id = 'atreeBody';
    add(root, head, body);
    var scroll = main.querySelector('.scroll');
    scroll.parentNode.insertBefore(root, scroll.nextSibling);

    var open = false, key = '', timer = null, debounce = null, subsTimer = null;
    var tree = null, subs = [], subsAt = 0, subsBusy = false, treeBusy = false, error = '';

    function cur() { return engine.current(); }
    function keyOf(c) { return c ? c.projectId + '::' + c.sessionId : ''; }
    function q(c) { return '?projectId=' + encodeURIComponent(c.projectId) + '&sessionId=' + encodeURIComponent(c.sessionId); }
    function getJson(path) { return engine.api(path).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'request failed'); return j; }); }); }
    function busyNow() { return !!(tree && tree.main && (tree.main.running || tree.main.background)); }

    function pressed(on) { ['chatAgentTree', 'atreeBtn'].forEach(function (id) { var b = document.getElementById(id); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
    function toggle() { if (open) close(); else show(); }
    function show() {
      if (engine.onOpen) engine.onOpen(); // closes the terminal: one view takes the chat's place
      open = true; root.hidden = false; main.classList.add('atree-open'); pressed(true);
      try { localStorage.setItem('x056_agent_tree', '1'); } catch (e) {}
      reload();
    }
    function close() {
      open = false; root.hidden = true; main.classList.remove('atree-open'); pressed(false); stop();
      try { localStorage.removeItem('x056_agent_tree'); } catch (e) {}
    }
    function stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (subsTimer) { clearTimeout(subsTimer); subsTimer = null; }
    }
    function schedule() { if (timer) clearTimeout(timer); timer = open ? setTimeout(tick, busyNow() ? FAST_MS : SLOW_MS) : null; }
    function tick() {
      timer = null;
      if (!open) return;
      if (keyOf(cur()) !== key) { reload(); return; }
      if (document.hidden) { schedule(); return; }
      refresh();
    }

    /** A different conversation, or a fresh open. */
    function reload() {
      stop();
      var c = cur();
      tree = null; subs = []; subsAt = 0; error = ''; treeBusy = false; subsBusy = false;
      key = keyOf(c);
      if (!c) { render(); return; }
      refresh(true);
    }

    function refresh(withSubs) {
      var c = cur(); if (!c || keyOf(c) !== key || treeBusy) { schedule(); return; }
      treeBusy = true;
      var myKey = key;
      getJson('/api/conversations/agent-tree' + q(c)).then(function (t) {
        if (myKey !== key) return;
        var wasBusy = busyNow();
        tree = t; error = '';
        render();
        // One more read on the busy -> idle edge, so a missed session_done cannot leave cards "running".
        if (withSubs || busyNow() || wasBusy) wantSubs();
      }).catch(function (e) { if (myKey === key) { error = e.message; render(); } })
        .then(function () { treeBusy = false; schedule(); });
    }
    /** The subagent list, throttled to one read per 5 s. */
    function wantSubs() {
      if (subsBusy || subsTimer || !open) return;
      var wait = SUBS_MIN_MS - (Date.now() - subsAt);
      if (wait > 0) { subsTimer = setTimeout(function () { subsTimer = null; wantSubs(); }, wait); return; }
      var c = cur(); if (!c || keyOf(c) !== key) return;
      subsBusy = true; subsAt = Date.now();
      var myKey = key;
      getJson('/api/conversations/subagents' + q(c)).then(function (d) {
        if (myKey !== key) return;
        subs = (d && d.subagents) || [];
        render();
      }).catch(function () { /* the next refresh retries */ }).then(function () { subsBusy = false; });
    }

    function onEvent(kind, data) {
      if (!open || EVENTS.indexOf(kind) < 0) return;
      var c = cur(); if (!c) return;
      data = data || {};
      if (data.sessionId ? data.sessionId !== c.sessionId : (data.projectId && data.projectId !== c.projectId)) return;
      var ended = kind === 'session_done' || kind === 'turn_state';
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () { debounce = null; refresh(ended); }, 250);
    }

    // ---- rendering -----------------------------------------------------------
    var lastSig = null;
    function render() {
      var sig = JSON.stringify([key, tree, subs, error]);
      if (sig === lastSig && body.firstChild) return; // nothing changed: keep focus and scroll untouched
      lastSig = sig;
      var top = body.scrollTop;
      body.textContent = '';
      if (!key) { title.textContent = ''; add(body, el('p', 'at-empty', 'No conversation selected.')); return; }
      if (!tree) { title.textContent = ''; add(body, el('p', 'at-empty', error ? 'Could not load: ' + error : 'loading…')); return; }
      var t = tree, h = t.helpers || {}, team = t.team, adv = t.advisor || { on: false };
      var turnStart = ms(t.turnStartedAt);
      var mainModel = modelName(t.main.model) || (t.provider === 'codex' ? 'ChatGPT' : 'Claude');
      title.textContent = mainModel.toUpperCase() + ' WORKS' + (adv.on ? ' · ' + modelName(adv.model).toUpperCase() + ' ON CALL' : '');

      // This turn's workers: running, or started since the turn began (no turn start = all).
      var thisTurn = subs.filter(function (s) { return s.status === 'running' || !isFinite(turnStart) || ms(s.startedAt) >= turnStart; });
      var earlier = subs.length - thisTurn.length;
      var picker = h.router === 'decisions' ? 'decisions' : 'jev';
      var showForks = !!team || (t.forks && t.forks.total > 0);

      add(body, legend(t, mainModel, showForks, picker));
      var grid = put(body, el('div', 'at-grid' + (adv.on ? ' has-adv' : '')));
      if (adv.on) add(grid, advisorColumn(adv, turnStart));
      var flow = el('ol', 'at-flow'); flow.setAttribute('aria-label', 'Pipeline');
      add(grid, flow);
      add(flow, mainNode(t, mainModel));
      if (showForks) { add(flow, link()); add(flow, forkNode(t.forks, picker)); }
      var anyWorkers = subs.length > 0 || (t.delegates || []).length > 0;
      if (team || subs.length) {
        add(flow, link(team ? 'delegate to subagents · ' : 'subagents', team ? teamLabel(team) : ''));
        add(flow, workersNode(thisTurn, earlier, t));
      }
      if ((t.delegates || []).length) { add(flow, link(team || subs.length ? '' : 'delegate to hidden workers')); add(flow, delegatesNode(t.delegates, t.gates || [])); }
      if (team || anyWorkers) { add(flow, link()); add(flow, backNode(t, mainModel)); }
      if (!h.advisor && !h.team && !h.router && !anyWorkers) {
        add(flow, el('li', 'at-hint', 'Turn on Advisor, Agent team or Jev from the ✦ button, or ask this conversation to delegate work.'));
      }
      add(body, logNode(t, thisTurn));
      body.scrollTop = top;
    }

    function legend(t, mainModel, showForks, picker) {
      var ul = el('ul', 'at-legend'); ul.setAttribute('aria-label', 'Legend');
      var chip = function (cls, text) { var li = el('li', cls); add(li, el('i'), el('span', '', text)); return li; };
      add(ul, chip('main', mainModel.toLowerCase() + (t.main.effort ? ' · ' + t.main.effort : '')));
      if (t.team || subs.length) add(ul, chip('sub', 'subagents' + (t.team ? ' · ' + (t.team.pickedBy && t.team.model ? modelName(t.team.model).toLowerCase() + ' · ' : '') + t.team.effort : '')));
      if (showForks) add(ul, chip('jev', picker + ' · forks'));
      if ((t.delegates || []).length) add(ul, chip('dg', 'delegates'));
      if (t.advisor && t.advisor.on) add(ul, chip('adv', modelName(t.advisor.model).toLowerCase() + ' · advisor'));
      return ul;
    }

    function link(label, strong) {
      var li = el('li', 'at-link' + (label ? ' labelled' : '')); li.setAttribute('aria-hidden', label ? 'false' : 'true');
      if (label) { var p = put(li, el('span', 'at-link-label', label)); if (strong) add(p, el('b', '', strong)); }
      return li;
    }

    function mainNode(t, mainModel) {
      var m = t.main, li = el('li', 'at-node main'); li.setAttribute('aria-label', 'Main session');
      add(li, add(el('div', 'at-node-title'), el('span', '', mainModel + ' · main session')));
      add(li, el('div', 'at-sub', 'plans + decides'));
      var eff = add(el('span', 'v'), m.effort ? effortBar(m.effort) : null, el('span', 'at-eff-label', m.effort || 'default'));
      add(li, row('', 'effort', eff));
      if (m.pickedBy) add(li, el('div', 'at-chip jev', 'picked by ' + (m.pickedBy === 'openai' ? 'OpenAI Decisions' : 'Jev') + (m.lean ? ' · lean ' + m.lean : '')));
      var st = m.running ? ['run', '● working'] : m.background ? ['bg', '◐ background work'] : ['idle', '○ idle'];
      add(li, el('div', 'at-status ' + st[0], st[1]));
      if (m.lastTurn) {
        var lt = m.lastTurn, bits = [];
        if (lt.steps != null) bits.push(lt.steps + ' step' + (lt.steps === 1 ? '' : 's'));
        if (lt.durationMs != null) bits.push(secs(lt.durationMs));
        if (lt.costUsd != null) bits.push('$' + lt.costUsd.toFixed(3));
        add(li, el('div', 'at-faint', 'last turn · ' + bits.join(' · ')));
      }
      return li;
    }

    function forkNode(f, picker) {
      f = f || { total: 0, sharp: 0, split: 0, recent: [] };
      var li = el('li', 'at-node fork'); li.setAttribute('aria-label', 'Fork layer');
      var hd = put(li, el('div', 'at-node-title spread'));
      add(hd, el('span', '', (picker === 'decisions' ? 'DECISIONS' : 'JEV') + ' · fork layer'));
      var cnt = put(hd, el('span', 'at-forkcount')); cnt.id = 'atreeForkCount';
      add(cnt, el('span', 'k', 'forks '), el('b', '', f.total));
      if (!f.total) { add(li, el('div', 'at-faint', 'no forks yet · small either-or questions go here')); return li; }
      var ul = put(li, el('ul', 'at-forks'));
      f.recent.slice(-FORKS_SHOWN).reverse().forEach(function (x) {
        var r = el('li', 'at-fork ' + (x.verdict === 'sharp' ? 'sharp' : 'split'));
        r.title = x.question + (x.choice ? ' → ' + x.choice : '') + (x.error ? ' · ' + x.error : '');
        add(r, el('span', 'q', one(x.question, 40)));
        var bar = put(r, el('span', 'at-meter')); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', 'confidence ' + (pct(x.confidence) || 'unknown'));
        var fill = put(bar, el('i')); fill.style.width = Math.round(Math.max(0, Math.min(1, x.confidence || 0)) * 100) + '%';
        add(r, el('span', 'p', x.confidence == null ? '—' : x.confidence.toFixed(2)), el('span', 'vd', x.verdict === 'sharp' ? 'SHARP' : 'SPLIT'));
        add(ul, r);
      });
      var foot = put(li, el('div', 'at-forkfoot'));
      add(foot, el('span', 'sharp', 'sharp ' + f.sharp + ' → followed'), el('span', 'split', 'split ' + f.split + ' → main model'));
      return li;
    }

    // The team's model and effort this turn: "effort medium" when fixed, the
    // picked "Sonnet · high · Jev 72%" when a picker chose them.
    function teamLabel(team) {
      if (!team.pickedBy) return 'effort ' + team.effort;
      return [team.model && modelName(team.model), team.effort, (team.pickedBy === 'openai' ? 'Decisions' : 'Jev') + (team.confidence != null ? ' ' + Math.round(team.confidence * 100) + '%' : '')].filter(Boolean).join(' · ');
    }
    function workerLabel(s, t) {
      if (!t.team) return '';
      if (t.provider === 'codex') return (t.team.pickedBy && t.team.model ? modelName(t.team.model) + ' · ' : '') + 'effort ' + t.team.effort;
      // Claude roles come in effort variants (explorer-high); the suffix is the effort.
      var m = /^(.*?)(?:-(low|high))?$/.exec(s.agentType || '');
      return t.team.roles.indexOf(m[1]) >= 0 ? modelName(t.team.model || 'opus') + ' · ' + (m[2] || 'medium') : '';
    }
    function subCard(s, t, kids) {
      var li = el('li', 'at-card ' + (s.status || 'unknown'));
      var b = put(li, el('button', 'at-card-btn')); b.type = 'button';
      var st = SUB_STATUS[s.status] || ['?', s.status || 'unknown'];
      b.setAttribute('aria-label', (s.agentType || 'agent') + ', ' + st[1] + ': ' + (s.description || s.brief || ''));
      add(b, el('span', 'at-card-role', s.agentType || 'agent'));
      var lab = workerLabel(s, t); if (lab) add(b, el('span', 'at-card-model', lab));
      add(b, el('span', 'at-card-desc', one(s.description || s.brief || '', 60)));
      add(b, el('span', 'at-card-status', st[0] + ' ' + st[1]));
      b.addEventListener('click', function () { if (engine.openSubagent) engine.openSubagent(s); });
      if (kids.length) {
        var ul = put(li, el('ul', 'at-kids')); ul.setAttribute('aria-label', 'spawned by ' + (s.agentType || 'agent'));
        kids.forEach(function (k) { add(ul, k); });
      }
      return li;
    }
    function workersNode(list, earlier, t) {
      var li = el('li', 'at-workers'); li.setAttribute('aria-label', 'Workers this turn');
      var ul = put(li, el('ul', 'at-cards'));
      // Nest by spawner: a child sits inside the card of the agent that spawned it.
      var byId = {}; list.forEach(function (s) { byId[s.agentId] = s; });
      var parentOf = function (s) {
        if (!s.spawnedBy || (s.spawnDepth || 1) <= 1) return null;
        if (byId[s.spawnedBy]) return s.spawnedBy;
        for (var i = 0; i < list.length; i++) if (list[i] !== s && (list[i].description === s.spawnedBy || list[i].agentType === s.spawnedBy)) return list[i].agentId;
        return null;
      };
      var kids = {};
      list.forEach(function (s) { var p = parentOf(s); if (p) (kids[p] = kids[p] || []).push(s); });
      var build = function (s, seen) {
        seen[s.agentId] = true;
        return subCard(s, t, (kids[s.agentId] || []).filter(function (k) { return !seen[k.agentId]; }).map(function (k) { return build(k, seen); }));
      };
      var seen = {};
      list.filter(function (s) { return !parentOf(s); }).forEach(function (s) { add(ul, build(s, seen)); });
      list.forEach(function (s) { if (!seen[s.agentId]) add(ul, build(s, seen)); });
      if (!list.length) add(ul, el('li', 'at-none', 'no workers this turn'));
      if (earlier > 0) { var e = put(li, el('div', 'at-earlier', '+' + earlier + ' earlier')); e.id = 'atreeEarlier'; e.title = 'subagents from earlier turns: ⋯ → Activity → Usage & subagents'; }
      return li;
    }

    function delegatesNode(list, gates) {
      var li = el('li', 'at-node dg'); li.setAttribute('aria-label', 'Delegates');
      var hd = put(li, el('div', 'at-node-title spread'));
      add(hd, el('span', '', 'delegates · hidden workers'));
      if (gates.length) add(hd, el('span', 'at-faint', 'report gate · ' + gates.length));
      var ul = put(li, el('ul', 'at-dgs'));
      list.forEach(function (d) {
        var r = el('li', 'at-dg ' + (d.status || ''));
        var b = put(r, el('button', 'at-dg-btn')); b.type = 'button'; b.dataset.delegate = d.id;
        b.setAttribute('aria-label', 'Delegate ' + d.role + ', ' + (DG_STATUS[d.status] || d.status) + ' — open its transcript');
        add(b, el('span', 'role', d.role));
        add(b, el('span', 'model', d.model ? modelName(d.model) + (d.effort ? ' · ' + d.effort : '') : 'default'));
        add(b, el('span', 'st', (d.working || d.status === 'working' ? '● ' : '○ ') + (DG_STATUS[d.status] || d.status) + ' · ' + d.turns + ' turn' + (d.turns === 1 ? '' : 's') + (d.pending && d.pending.length ? ' · ' + d.pending.length + ' queued' : '')));
        if (d.lastReport && d.lastReport.gate) add(b, el('span', 'gate ' + d.lastReport.gate, GATE[d.lastReport.gate] || d.lastReport.gate));
        b.addEventListener('click', function () { if (engine.openDelegate) engine.openDelegate(d.id, d.role); });
        add(ul, r);
      });
      return li;
    }

    function backNode(t, mainModel) {
      var li = el('li', 'at-node back'); li.setAttribute('aria-label', 'Back to the main session');
      add(li, el('div', 'at-node-title', 'back to main session' + (t.main.effort ? ' · ' + t.main.effort : '')));
      add(li, el('div', 'at-sub', 'review + verify'));
      return li;
    }

    function advisorColumn(a, turnStart) {
      var col = el('aside', 'at-adv'); col.setAttribute('aria-label', 'Advisor');
      add(col, el('div', 'at-node-title', modelName(a.model).toUpperCase()));
      add(col, el('div', 'at-sub', 'advisor · on call'));
      var calls = a.calls || [];
      var ul = put(col, el('ul', 'at-checks')); ul.setAttribute('aria-label', 'Checkpoints');
      CHECKPOINTS.forEach(function (cp) {
        var li = el('li', 'at-check');
        li.dataset.trigger = cp[0];
        add(li, el('span', 'dia', '◇'), el('span', 'lbl', cp[1]));
        if (a.checkpoints) {
          var hit = calls.filter(function (c) { return c.trigger === cp[0] && (!isFinite(turnStart) || ms(c.at) >= turnStart); }).pop();
          if (hit) {
            li.classList.add('lit'); li.firstChild.textContent = '◆';
            add(li, el('span', 'vd ' + (hit.error ? 'err' : hit.verdict === 'adjust' || hit.verdict === 'concern' ? 'warn' : 'ok'), hit.error ? 'error' : VERDICT[hit.verdict] || hit.verdict || ''));
            li.setAttribute('aria-label', cp[1] + ': consulted this turn' + (hit.verdict ? ', ' + (VERDICT[hit.verdict] || hit.verdict) : ''));
          } else li.setAttribute('aria-label', cp[1] + ': not reached this turn');
        } else {
          li.classList.add('neutral');
          li.setAttribute('aria-label', cp[1] + ': not tracked — Claude decides when to consult');
        }
        add(ul, li);
      });
      add(col, row('', 'calls', el('b', 'v', calls.length)));
      if (a.kind === 'claude') {
        var times = calls.slice(-5).reverse();
        if (times.length) {
          var tl = put(col, el('ul', 'at-calls'));
          times.forEach(function (c) { add(tl, el('li', c.status === 'reviewed' ? '' : 'warn', clock(ms(c.at)) + ' · ' + c.status)); });
        }
        if (a.note) add(col, el('p', 'at-note', a.note));
      } else {
        var last = calls.filter(function (c) { return c.advice; }).pop();
        if (last) { add(col, el('div', 'at-faint', 'last advice:')); add(col, el('p', 'at-advice', '» ' + one(last.advice, 220))); }
        add(col, el('p', 'at-note', 'reviews the turn at the checkpoints above; never writes code itself.'));
      }
      return col;
    }

    function logNode(t, thisTurn) {
      var ev = [];
      var push = function (at, tag, cls, text) { at = ms(at); if (isFinite(at)) ev.push({ at: at, tag: tag, cls: cls, text: text }); };
      thisTurn.forEach(function (s) {
        push(s.startedAt, s.agentType || 'agent', 'sub', 'started · ' + one(s.description || s.brief, 70));
        if (s.endedAt) push(s.endedAt, s.agentType || 'agent', 'sub', (SUB_STATUS[s.status] || ['', s.status])[1] + ' · ' + one(s.description || s.brief, 60));
      });
      ((t.forks && t.forks.recent) || []).forEach(function (f) {
        push(f.at, f.backend === 'openai' ? 'decisions' : 'jev', 'jev', one(f.question, 50) + (f.choice ? ' → ' + one(f.choice, 30) : '') + (f.confidence != null ? '  p=' + f.confidence.toFixed(2) : '') + '  ' + (f.verdict === 'sharp' ? 'SHARP → follow' : 'SPLIT → main model') + (f.error ? ' · ' + f.error : ''));
      });
      (t.gates || []).forEach(function (g) {
        var role = String(g.question || '').replace(/^report gate · /, '');
        push(g.at, 'gate', 'gate', role + ' → ' + (g.choice || 'unsure') + (g.confidence != null ? '  p=' + g.confidence.toFixed(2) : ''));
      });
      var a = t.advisor || {};
      (a.calls || []).forEach(function (c) {
        var tag = modelName(a.model).split(' ')[0].toLowerCase() || 'advisor';
        if (a.kind === 'claude') push(c.at, tag, 'adv', 'advisor ' + c.status + (c.error ? ' · ' + c.error : ''));
        else push(c.at, tag, 'adv', (CHECKPOINTS.filter(function (x) { return x[0] === c.trigger; })[0] || [0, c.trigger])[1] + ' · ' + (c.error ? 'error: ' + c.error : VERDICT[c.verdict] || c.verdict || ''));
      });
      (t.picks || []).forEach(function (p) {
        var what = p.error ? 'error: ' + p.error : (p.notes && p.notes.length ? p.notes.join(', ') : [p.model ? 'model ' + p.model : '', p.effort ? 'effort ' + p.effort : ''].filter(Boolean).join(', ') || 'unchanged');
        push(p.at, p.backend === 'openai' ? 'decisions' : 'jev', 'jev', what.replace(/->/g, '→'));
      });
      (t.delegates || []).forEach(function (d) {
        if (d.lastReport) push(d.lastReport.at, d.role, 'dg', (GATE[d.lastReport.gate] || d.lastReport.gate || d.lastReport.status || 'report') + ' · ' + one(String(d.lastReport.text || '').split('\n')[0], 70));
      });
      ev.sort(function (x, y) { return y.at - x.at; });
      var sec = el('section', 'at-log'); sec.setAttribute('aria-label', 'Session log');
      add(sec, el('h3', '', 'session log'));
      var ol = put(sec, el('ol'));
      ev.slice(0, LOG_MAX).forEach(function (e) {
        var li = el('li', e.cls);
        add(li, el('span', 't', clock(e.at)), el('span', 'g', e.tag), el('span', 'x', e.text));
        add(ol, li);
      });
      if (!ev.length) add(ol, el('li', 'none', 'nothing yet'));
      return sec;
    }

    var api = { toggle: toggle, show: show, close: close, isOpen: function () { return open; }, conversationChanged: function () { if (open) reload(); }, event: onEvent };
    try { if (localStorage.getItem('x056_agent_tree') === '1') setTimeout(show, 0); } catch (e) {}
    return api;
  };
})();
