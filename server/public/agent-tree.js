/*
 * Agent tree: one conversation's working setup at a glance -- the main
 * session, its advisor, the Jev fork layer, the workers it delegated to (team
 * subagents, workflow runs and delegates), and a log of what just passed
 * between them.
 *
 * Two views over one set of reads:
 *  - the docked pane (first half of this file): an outline to the RIGHT of the chat,
 *    per turn, with each node's own history; the chat and composer stay
 *    usable, and it may sit beside the terminal view.
 *  - the expanded console view (below): the whole conversation component's
 *    place, chat AND composer hidden; exclusive with the terminal view.
 *
 * Reads GET /api/conversations/agent-tree (cheap) on open, on live events and
 * on a slow poll. The subagent list is the panel's own (engine.subagents(),
 * one reader for the whole page), refreshed on open and on busy edges.
 */
/*
 * ---- The docked pane ----
 * Agent tree, docked: an indented outline beside the chat (the chat and the
 * composer stay usable), one turn at a time, and a second column with the
 * history of whichever node is open.
 *
 * Also the shared model the expanded console view (second half) draws from:
 * status words, sibling order, turns and which node belongs to which turn.
 *
 * The owner's four rules, enforced here:
 *  (a) truthful status: every server value has its own glyph, colour and
 *      words; nothing but `done` ever reads as done ("ended" = no result).
 *  (b) working first: running, needs you, done, ended, stopped, failed.
 *  (c) "Earlier turns" expands in place, grouped by turn, and folds again.
 *  (d) per turn: only nodes active or used in the selected turn, with a
 *      stepper over the turns the server reports.
 */
(function () {
  'use strict';

  // ---- status: one table, every value ---------------------------------------
  // key -> [css key, words]. Sibling rank follows rule (b).
  var STATUS = {
    run: ['run', 'Working'], bg: ['run', 'Background work'], needs: ['needs', 'Needs you'], blocked: ['needs', 'Blocked'],
    done: ['done', 'Done'], reported: ['idle', 'Reported'], idle: ['idle', 'Idle'],
    ended: ['ended', 'Ended · no result'], stopped: ['stopped', 'Stopped'], failed: ['failed', 'Failed'],
    interrupted: ['failed', 'Interrupted'], unknown: ['unknown', 'Status unknown'],
  };
  var RANK = { run: 0, needs: 1, done: 2, idle: 2, ended: 3, stopped: 4, failed: 5, unknown: 6 };
  function st(k) { var s = STATUS[k] || STATUS.unknown; return { id: STATUS[k] ? k : 'unknown', key: s[0], label: s[1] }; }
  /** A subagent / Codex child / workflow agent status from the server. */
  function subStatus(v) {
    return v === 'running' ? 'run' : v === 'done' ? 'done' : v === 'failed' ? 'failed' : v === 'stopped' ? 'stopped' : v === 'ended' ? 'ended' : 'unknown';
  }
  function delegateStatus(d) {
    if (d.working || d.status === 'working') return 'run';
    if (d.status === 'interrupted') return 'interrupted';
    if (d.status === 'failed') return 'failed';
    if (d.status === 'stopped') return 'stopped';
    var g = d.lastReport && d.lastReport.gate;
    if (g === 'needs_human') return 'needs';
    if (g === 'blocked') return 'blocked';
    if (g === 'done') return 'done';
    return d.lastReport ? 'reported' : 'idle';
  }
  /** The gate pill, only where the status does not already say it: "needs
   *  orchestrator" reads as plain "Reported" otherwise. */
  function gateOnly(d) { var g = d.lastReport && d.lastReport.gate; return g === 'needs_orchestrator' && delegateStatus(d) === 'reported' ? g : ''; }
  var WF_STALE_MS = 5 * 60 * 1000;
  function runStatus(r) {
    var live = r.live != null ? !!r.live : (r.started > r.finished && r.updatedAt && Date.now() - ms(r.updatedAt) < WF_STALE_MS);
    if (live) return 'run';
    // A run whose agents failed is not "done", even once every agent returned.
    if (r.failed > 0) return 'failed';
    if (r.started > 0 && r.finished >= r.started) return 'done';
    return 'ended';
  }
  function wfAgentStatus(a) {
    if (a.failed) return 'failed';
    if (a.status) return subStatus(a.status);
    return a.done ? 'done' : 'unknown';
  }
  function rankOf(k) { var r = RANK[st(k).key]; return r == null ? 6 : r; }
  function bySt(arr) {
    return arr.map(function (x, i) { return [x, i]; })
      .sort(function (a, b) { return rankOf(a[0].status) - rankOf(b[0].status) || a[1] - b[1]; })
      .map(function (p) { return p[0]; });
  }
  function bestRank(kids) { return kids.reduce(function (m, k) { return Math.min(m, k.status ? rankOf(k.status) : 9); }, 9); }

  // ---- small helpers ---------------------------------------------------------
  function ms(v) { if (v == null || v === '') return NaN; if (typeof v === 'number') return v; return Date.parse(v); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return p; }
  function icon(name, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u); return s;
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function one(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function clock(t) { if (!isFinite(t)) return ''; var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()); }
  function clockS(t) { if (!isFinite(t)) return ''; var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function when(t) {
    if (!isFinite(t)) return '';
    var d = new Date(t), now = new Date();
    return d.toDateString() === now.toDateString() ? clock(t) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + clock(t);
  }
  function pct(c) { return c == null ? '' : Math.round(c * 100) + '%'; }
  function dur(a, b) {
    a = ms(a); b = ms(b); if (!isFinite(a)) return '';
    var s = Math.max(0, Math.round(((isFinite(b) ? b : Date.now()) - a) / 1000));
    if (s < 60) return s + 's'; var m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's';
    var h = Math.floor(m / 60); return h < 48 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd';
  }
  function tok(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
  function usageTok(u) { return u ? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0; }
  function modelName(m) {
    if (!m) return '';
    m = String(m).replace(/\[.*\]$/, '');
    var gpt = /^gpt-([\d.]+)(?:-(.+))?$/i.exec(m);
    if (gpt) return 'GPT-' + gpt[1] + (gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : '');
    var cl = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(m);
    if (cl) return cap(cl[1]) + ' ' + cl[2] + (cl[3] ? '.' + cl[3] : '');
    return m.split('-').map(cap).join(' ');
  }
  function roleName(s) { return s.agentType === 'codex-subagent' ? 'Codex agent' : cap(s.agentType || 'agent'); }

  // ---- turns and membership ---------------------------------------------------
  /** The turns to step through. Without `turns` from the server: one turn,
   *  from the known start of this one. */
  function turnsOf(t) {
    var list = (t && Array.isArray(t.turns) && t.turns.length) ? t.turns.slice() : null;
    if (!list) {
      var s = t ? ms(t.turnStartedAt) : NaN;
      list = [{ n: 1, startedAt: isFinite(s) ? t.turnStartedAt : null, endedAt: null, prompt: '', running: !!(t && t.main && t.main.running), fallback: true }];
    }
    return list.map(function (x, i) {
      var start = ms(x.startedAt);
      var end = x.endedAt != null ? ms(x.endedAt) : NaN;
      // No recorded end = still open (the server's rule: endedAt ?? Infinity).
      return { n: x.n != null ? x.n : i + 1, start: isFinite(start) ? start : -Infinity, end: isFinite(end) ? end : Infinity, prompt: x.prompt || '', running: !!x.running, at: start, last: i === list.length - 1, fallback: !!x.fallback };
    });
  }
  /** node ∈ turn iff it started before the turn ended AND (it is running, or it
   *  ended / last moved after the turn began). */
  function inTurn(turn, start, end, running) {
    var s = isFinite(start) ? start : -Infinity;
    if (!(s < turn.end)) return false;
    if (running) return true;
    // Mirrors server/agent-tree.ts: no end and no last update means not in it.
    return isFinite(end) && end >= turn.start;
  }
  function within(turn, at) { at = ms(at); return isFinite(at) && at >= turn.start && at < turn.end; }
  /** The turn whose window holds a moment (for grouping earlier work by turn). */
  function turnAt(turns, at) {
    at = ms(at); if (!isFinite(at)) return null;
    for (var i = turns.length - 1; i >= 0; i--) if (at >= turns[i].start) return turns[i];
    return turns[0] || null;
  }
  function subTimes(s) { return { start: ms(s.startedAt), end: isFinite(ms(s.endedAt)) ? ms(s.endedAt) : ms(s.updatedAt) }; }
  function dgTimes(d, reports) {
    var mine = reports.filter(function (r) { return r.delegateId === d.id; });
    var ats = mine.map(function (r) { return ms(r.at); }).filter(isFinite);
    if (d.lastReport && isFinite(ms(d.lastReport.at))) ats.push(ms(d.lastReport.at));
    var start = ms(d.createdAt);
    if (!isFinite(start) && d.lastReport && isFinite(ms(d.lastReport.at))) start = ms(d.lastReport.at) - (d.lastReport.durationMs || 0);
    return { start: start, reports: ats, end: ats.length ? Math.max.apply(null, ats) : ms(d.updatedAt) };
  }

  // ---- the model: one turn as a tree ------------------------------------------
  var ROLE = { main: 'var(--ap-main)', advisor: 'var(--ap-adv)', jev: 'var(--ap-jev)', sub: 'var(--ap-sub)', dg: 'var(--ap-dg)', wf: 'var(--ap-sub)', earlier: 'var(--faint)' };

  function teamLabel(team) {
    if (!team) return '';
    return [team.model && modelName(team.model), team.effort].filter(Boolean).join(' · ');
  }
  function teamPick(team) {
    if (!team || !team.pickedBy) return '';
    return (team.pickedBy === 'openai' ? 'Decisions' : 'Jev') + (team.confidence != null ? ' ' + pct(team.confidence) : '');
  }
  function subLeaf(s, fmt) {
    var u = usageTok(s.usage), cost = fmt && fmt.costLabel ? fmt.costLabel(s.cost) : '';
    return { key: 'sub:' + s.agentId, id: 'sub:' + s.agentId, kind: 'sub', color: ROLE.sub, name: roleName(s), brief: one(s.description || s.brief, 120), status: subStatus(s.status),
      bits: [dur(s.startedAt, s.endedAt || (s.status === 'running' ? null : s.updatedAt)), u ? tok(u) + ' tok' : '', cost].filter(Boolean).join(' · '), raw: s };
  }
  /** Nest workers by spawner: parentAgentId first, else the older spawnedBy guess. */
  function nest(list, fmt) {
    var byId = {}; list.forEach(function (s) { byId[s.agentId] = s; });
    var parentOf = function (s) {
      if (s.parentAgentId && byId[s.parentAgentId] && s.parentAgentId !== s.agentId) return s.parentAgentId;
      if (!s.spawnedBy || (s.spawnDepth || 1) <= 1) return null;
      if (byId[s.spawnedBy]) return s.spawnedBy;
      for (var i = 0; i < list.length; i++) if (list[i] !== s && (list[i].description === s.spawnedBy || list[i].agentType === s.spawnedBy)) return list[i].agentId;
      return null;
    };
    var kids = {}; list.forEach(function (s) { var p = parentOf(s); if (p) (kids[p] = kids[p] || []).push(s); });
    var seen = {};
    var build = function (s) {
      seen[s.agentId] = true;
      var leaf = subLeaf(s, fmt);
      var k = (kids[s.agentId] || []).filter(function (c) { return !seen[c.agentId]; }).map(build);
      if (k.length) leaf.kids = bySt(k);
      return leaf;
    };
    var roots = list.filter(function (s) { return !parentOf(s); }).map(build);
    list.forEach(function (s) { if (!seen[s.agentId]) roots.push(build(s)); });
    return bySt(roots);
  }

  /**
   * data: {tree, subs, runs, runAgents, reports}; n: the selected turn number
   * (null = the latest). Returns {turns, turn, cur, main, helpers, tiers, earlier}.
   */
  function build(data, n, fmt) {
    var t = data.tree || {}, subs = data.subs || [], runs = data.runs || [], runAgents = data.runAgents || {}, reports = data.reports || [];
    var turns = turnsOf(t);
    var turn = turns.filter(function (x) { return x.n === n; })[0] || turns[turns.length - 1];
    var cur = turn.last;
    var h = t.helpers || {}, m = t.main || {}, team = t.team, adv = t.advisor || { on: false };
    var picker = h.router === 'decisions' ? 'Decisions' : 'Jev';

    var mainStatus = cur ? (m.running ? 'run' : m.background ? 'bg' : 'idle') : 'done';
    if (!cur && turn.running) mainStatus = 'run';
    var mainModel = modelName(m.model) || (t.provider === 'codex' ? 'ChatGPT' : 'Claude');
    var lt = m.lastTurn;
    var main = { key: 'main', id: 'main', kind: 'main', color: ROLE.main, name: 'Main session', status: mainStatus,
      brief: cur ? [mainModel, m.effort].filter(Boolean).join(' · ') : one(turn.prompt, 90) || 'Turn ' + turn.n,
      pick: cur && m.pickedBy ? (m.pickedBy === 'openai' ? 'Decisions' : 'Jev') + (m.lean ? ' · lean ' + m.lean : '') : '',
      bits: cur && lt ? [lt.steps != null ? lt.steps + ' steps' : '', lt.durationMs != null ? dur(0, lt.durationMs) : '', lt.costUsd != null ? '$' + lt.costUsd.toFixed(2) : ''].filter(Boolean).join(' · ') : (isFinite(turn.at) ? 'Started ' + when(turn.at) : '') };

    // Helpers: shown when used in this turn (and, on the latest turn, when on).
    var helpers = [];
    var calls = (adv.calls || []).filter(function (c) { return within(turn, c.at); });
    if ((adv.on && cur) || calls.length) {
      var last = calls[calls.length - 1];
      helpers.push({ key: 'advisor', id: 'advisor', kind: 'advisor', color: ROLE.advisor, name: 'Advisor', brief: modelName(adv.model) || (t.provider === 'codex' ? 'ChatGPT advisor' : 'Claude advisor'),
        bits: calls.length + ' call' + (calls.length === 1 ? '' : 's') + (last && last.verdict ? ' · ' + String(last.verdict).replace('_', ' ') : '') });
    }
    var f = t.forks || { recent: [] };
    var forks = (f.recent || []).filter(function (x) { return within(turn, x.at); });
    var picks = (t.picks || []).filter(function (p) { return within(turn, p.at); });
    if (((h.team || h.router) && cur) || forks.length || picks.length) {
      var sharp = forks.filter(function (x) { return x.verdict === 'sharp'; }).length;
      helpers.push({ key: 'jev', id: 'jev', kind: 'jev', color: ROLE.jev, name: picker + ' forks',
        brief: forks.length ? sharp + ' sharp, followed · ' + (forks.length - sharp) + ' split, main decided' : picks.length ? picks.length + ' pick' + (picks.length === 1 ? '' : 's') + ' this turn' : 'No forks this turn',
        bits: forks.length + ' fork' + (forks.length === 1 ? '' : 's'),
        kids: forks.slice().reverse().map(function (x, i) {
          return { key: 'fork:' + (x.at || i), id: 'jev', kind: 'fork', color: ROLE.jev, name: one(x.question, 80), brief: (x.choice ? '→ ' + one(x.choice, 40) + ' · ' : '') + (x.confidence != null ? pct(x.confidence) : ''), verdict: x.verdict };
        }) });
    }

    // Branches: team, delegates, workflow runs.
    var tiers = [];
    var mine = subs.filter(function (s) { var tt = subTimes(s); return inTurn(turn, tt.start, tt.end, s.status === 'running'); });
    if (team || mine.length) {
      tiers.push({ key: 'team', kind: 'team', group: true, color: ROLE.sub, name: team ? 'Agent team' : 'Subagents',
        brief: cur && team ? teamLabel(team) : mine.length + ' worker' + (mine.length === 1 ? '' : 's'), pick: cur ? teamPick(team) : '',
        kids: nest(mine, fmt), empty: 'No workers in this turn' });
    }
    var dgs = (t.delegates || []).filter(function (d) {
      var tt = dgTimes(d, reports), running = delegateStatus(d) === 'run';
      if (running) return tt.start < turn.end || !isFinite(tt.start);
      return tt.reports.some(function (a) { return a >= turn.start && a < turn.end; }) || within(turn, d.createdAt) || inTurn(turn, tt.start, tt.end, false);
    });
    if (dgs.length) {
      tiers.push({ key: 'dgroup', kind: 'dgroup', group: true, color: ROLE.dg, name: 'Delegates', brief: 'Reports gated by ' + picker,
        kids: bySt(dgs.map(function (d) {
          return { key: 'dg:' + d.id, id: 'dg:' + d.id, kind: 'delegate', color: ROLE.dg, name: cap(d.role), brief: (d.provider === 'codex' ? 'ChatGPT' : 'Claude') + (d.model ? ' · ' + modelName(d.model) : ''),
            status: delegateStatus(d), gate: gateOnly(d), bits: (d.turns || 0) + ' turn' + (d.turns === 1 ? '' : 's') + (d.pending && d.pending.length ? ' · ' + d.pending.length + ' queued' : ''), raw: d };
        })) });
    }
    var myRuns = runs.filter(function (r) { var s = runStatus(r); return inTurn(turn, ms(r.startedAt), ms(r.updatedAt), s === 'run'); });
    if (myRuns.length) {
      tiers.push({ key: 'wfgroup', kind: 'wfgroup', group: true, color: ROLE.wf, name: 'Workflow runs', brief: myRuns.length + ' run' + (myRuns.length === 1 ? '' : 's'),
        kids: bySt(myRuns.map(function (r) {
          var ags = runAgents[r.runId];
          return { key: 'wf:' + r.runId, kind: 'wfrun', group: true, lazy: !ags, runId: r.runId, color: ROLE.wf, name: r.name || r.runId,
            brief: r.description || (r.phases && r.phases.length ? r.phases.map(function (p) { return p.title; }).join(' → ') : ''),
            status: runStatus(r), bits: (r.finished || 0) + ' of ' + (r.started || 0) + ' agents', raw: r,
            kids: ags ? bySt(ags.map(function (a) {
              return { key: 'wfa:' + r.runId + ':' + a.agentId, id: 'wfa:' + r.runId + ':' + a.agentId, kind: 'wfagent', color: ROLE.wf, name: one(a.brief || a.agentType || a.agentId, 70), brief: a.agentType || '',
                status: wfAgentStatus(a), bits: '', raw: a, run: r };
            })) : [{ key: 'wfload:' + r.runId, kind: 'note', name: 'Loading agents…' }] };
        })) });
    }
    tiers = tiers.map(function (x, i) { return [x, i]; }).sort(function (a, b) { return bestRank(a[0].kids) - bestRank(b[0].kids) || a[1] - b[1]; }).map(function (p) { return p[0]; });

    // Earlier turns: each earlier turn with the work that STARTED in it.
    var earlier = [];
    turns.forEach(function (x) {
      if (x.n >= turn.n || x.fallback) return;
      var w = [];
      subs.forEach(function (s) { if (turnAt(turns, s.startedAt) === x) w.push(subLeaf(s, fmt)); });
      runs.forEach(function (r) { if (turnAt(turns, r.startedAt) === x) w.push({ key: 'e-wf:' + r.runId, kind: 'wfrun-e', color: ROLE.wf, name: 'Workflow · ' + (r.name || r.runId), status: runStatus(r), bits: (r.finished || 0) + ' of ' + (r.started || 0) + ' agents' }); });
      (t.delegates || []).forEach(function (d) { if (turnAt(turns, d.createdAt) === x) w.push({ key: 'e-dg:' + d.id, id: 'dg:' + d.id, kind: 'delegate', color: ROLE.dg, name: 'Delegate · ' + cap(d.role), status: delegateStatus(d), gate: gateOnly(d) }); });
      earlier.push({ turn: x, workers: bySt(w) });
    });
    earlier.reverse();
    // Without turns, the fold still holds every worker from before this turn.
    if (turns.length === 1 && turns[0].fallback && isFinite(turn.start)) {
      var old = subs.filter(function (s) { return s.status !== 'running' && ms(s.startedAt) < turn.start; });
      if (old.length) earlier.push({ turn: { n: null, at: NaN, prompt: 'Before this turn' }, workers: bySt(old.map(function (s) { return subLeaf(s, fmt); })) });
    }

    return { turns: turns, turn: turn, cur: cur, main: main, helpers: helpers, tiers: tiers, earlier: earlier, provider: t.provider, picker: picker };
  }

  function outlineItems(M) {
    var main = Object.assign({}, M.main, { kids: [] });
    M.helpers.forEach(function (h) { main.kids.push(h); });
    M.tiers.forEach(function (t) { main.kids.push(t); });
    var items = [main];
    if (M.earlier.length) {
      var n = M.earlier.reduce(function (s, e) { return s + e.workers.length; }, 0);
      items.push({ key: 'earlier', kind: 'earlier', group: true, color: ROLE.earlier, name: 'Earlier turns', brief: n + ' worker' + (n === 1 ? '' : 's') + ' · ' + M.earlier.length + ' turn' + (M.earlier.length === 1 ? '' : 's'),
        kids: M.earlier.map(function (e) {
          return { key: 'turn:' + (e.turn.n == null ? 'before' : e.turn.n), kind: 'turngroup', group: true, color: ROLE.earlier, name: e.turn.n == null ? 'Before this turn' : 'Turn ' + e.turn.n,
            brief: [when(e.turn.at), one(e.turn.prompt, 70)].filter(Boolean).join(' · '), bits: e.workers.length ? '' : 'no workers',
            kids: e.workers.map(function (w) { return Object.assign({}, w, { key: 'e:' + w.key, kids: null }); }) };
        }) });
    }
    return items;
  }

  // ---- glyphs ---------------------------------------------------------------
  function glyph(k) {
    var s = st(k), g = el('span', 'ap-g ap-g-' + s.key); g.setAttribute('aria-hidden', 'true');
    if (s.key === 'done') g.appendChild(icon('check'));
    else if (s.key === 'failed') g.appendChild(icon('x'));
    else if (s.key === 'needs') g.textContent = '!';
    return g;
  }
  function statusChip(k) {
    var s = st(k), c = el('span', 'ap-st ap-st-' + s.key);
    c.dataset.status = s.id;
    add(c, glyph(k), el('span', 'ap-st-t', s.label));
    return c;
  }
  var GATE = { needs_human: ['needs', 'Needs you'], needs_orchestrator: ['link', 'Needs orchestrator'], done: ['done', 'Done'], blocked: ['failed', 'Blocked'] };
  function gatePill(g) { var x = GATE[g] || ['idle', g]; return el('span', 'ap-gate ap-gate-' + x[0], x[1]); }

  window.AgentTreeModel = { build: build, turnsOf: turnsOf, inTurn: inTurn, status: st, subStatus: subStatus, delegateStatus: delegateStatus, runStatus: runStatus, wfAgentStatus: wfAgentStatus, bySt: bySt, rankOf: rankOf, glyph: glyph, statusChip: statusChip, modelName: modelName, when: when, outlineItems: outlineItems };

  // =========================================================================
  // The docked pane
  // =========================================================================
  var W_KEY = 'x056_agent_pane_w', W_MIN = 320, W_MAX = 560, W_DEF = 420, HIST_W = 340, CHAT_MIN = 380;

  window.createAgentPane = function (o) {
    var engine = o.engine;
    var host = document.getElementById('conversationSurface') || document.querySelector('body > main');
    var pane = el('aside', 'ap'); pane.id = 'agentPane'; pane.hidden = true; pane.setAttribute('aria-label', 'Agent tree');
    var grip = el('div', 'ap-grip'); grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', 'Resize the agent tree'); grip.tabIndex = 0;
    var head = el('header', 'ap-head');
    var hIcon = el('span', 'ap-hicon'); hIcon.appendChild(icon('tree'));
    var live = el('span', 'ap-live'); live.id = 'agentPaneLive';
    var stepper = el('div', 'ap-turn'); stepper.setAttribute('role', 'group'); stepper.setAttribute('aria-label', 'Turn');
    var prev = el('button', 'ap-ib'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous turn'); prev.title = 'Previous turn'; prev.appendChild(icon('left'));
    var turnLabel = el('span', 'ap-turn-l'); turnLabel.id = 'agentPaneTurn'; turnLabel.setAttribute('aria-live', 'polite');
    var next = el('button', 'ap-ib'); next.type = 'button'; next.setAttribute('aria-label', 'Next turn'); next.title = 'Next turn'; next.appendChild(icon('right'));
    add(stepper, prev, turnLabel, next);
    var expandBtn = el('button', 'ap-ib'); expandBtn.type = 'button'; expandBtn.id = 'agentPaneExpand'; expandBtn.setAttribute('aria-label', 'Expand the agent tree over the conversation'); expandBtn.title = 'Expand'; expandBtn.appendChild(icon('expand'));
    var closeBtn = el('button', 'ap-ib'); closeBtn.type = 'button'; closeBtn.id = 'agentPaneClose'; closeBtn.setAttribute('aria-label', 'Close the agent tree'); closeBtn.title = 'Close'; closeBtn.appendChild(icon('x'));
    add(head, hIcon, el('b', 'ap-title', 'Agent tree'), live, el('span', 'ap-sp'), stepper, expandBtn, closeBtn);
    var note = el('div', 'ap-tnote'); note.hidden = true;
    var cols = el('div', 'ap-cols');
    var outline = el('div', 'ap-outline'); outline.id = 'agentPaneOutline';
    var hist = el('div', 'ap-hist'); hist.id = 'agentPaneHistory'; hist.hidden = true;
    add(cols, outline, hist);
    add(pane, grip, head, note, cols);
    host.appendChild(pane);

    var S = { data: null, turn: null, exp: { main: 1, team: 1, dgroup: 1, wfgroup: 1 }, focus: 'main', sel: null, node: null, tab: 'conv', sig: '', M: null };
    var width = W_DEF; try { var w0 = parseInt(localStorage.getItem(W_KEY), 10); if (w0) width = Math.max(W_MIN, Math.min(W_MAX, w0)); } catch (e) {}

    // ---- layout ----
    function hostWidth() { return host.getBoundingClientRect().width || window.innerWidth; }
    function sheet() { return hostWidth() < width + CHAT_MIN; }
    function twoCol() { return !sheet() && hostWidth() - (width + HIST_W) >= CHAT_MIN; }
    function layout() {
      var sh = sheet(), wide = !!S.node && twoCol();
      pane.classList.toggle('ap-sheet', sh);
      pane.classList.toggle('ap-wide', wide);
      pane.classList.toggle('ap-drill', !!S.node && !wide);
      pane.style.width = sh ? '' : (width + (wide ? HIST_W : 0)) + 'px';
      pane.style.setProperty('--ap-outline-w', width + 'px');
      document.body.style.setProperty('--agent-pane-w', (sh ? 0 : width + (wide ? HIST_W : 0)) + 'px');
      // Crossing between two columns and drill-in changes the history's header (back vs close).
      var drill = !!S.node && !wide;
      if (H && H.drawn && H.drill !== drill) drawHistory(false);
    }
    new ResizeObserver(function () { if (!pane.hidden) layout(); }).observe(host);

    grip.addEventListener('pointerdown', function (e) {
      if (sheet()) return;
      e.preventDefault(); grip.setPointerCapture(e.pointerId); pane.classList.add('ap-resizing');
      var x0 = e.clientX, w0 = width;
      function move(ev) { width = Math.max(W_MIN, Math.min(W_MAX, w0 + (x0 - ev.clientX))); layout(); }
      function up() { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); pane.classList.remove('ap-resizing'); try { localStorage.setItem(W_KEY, String(width)); } catch (er) {} }
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0; if (!d) return;
      e.preventDefault(); width = Math.max(W_MIN, Math.min(W_MAX, width + d)); layout(); try { localStorage.setItem(W_KEY, String(width)); } catch (er) {}
    });

    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });
    expandBtn.addEventListener('click', function () { o.onExpand(); });
    closeBtn.addEventListener('click', function () { o.onClose(); });
    function step(d) {
      if (!S.M) return;
      var ns = S.M.turns.map(function (x) { return x.n; }), i = ns.indexOf(S.M.turn.n) + d;
      if (i < 0 || i >= ns.length) return;
      S.turn = i === ns.length - 1 ? null : ns[i]; S.sig = ''; render();
    }
    pane.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.node) { e.preventDefault(); e.stopPropagation(); closeNode(); }
    });

    // ---- the outline ----
    function render() {
      if (pane.hidden || !S.data) return;
      layout();
      var M = S.M = build(S.data, S.turn, engine);
      var ns = M.turns.map(function (x) { return x.n; }), i = ns.indexOf(M.turn.n);
      prev.disabled = i <= 0; next.disabled = i >= ns.length - 1;
      stepper.hidden = M.turns.length < 2 && M.turns[0].fallback;
      turnLabel.textContent = 'Turn ' + M.turn.n + ' · ' + (M.cur ? 'now' : when(M.turn.at) || 'earlier');
      var liveNow = M.cur && (M.main.status === 'run' || M.main.status === 'bg' || M.tiers.some(function (x) { return x.kids.some(function (k) { return k.status === 'run'; }); }));
      live.className = 'ap-live' + (liveNow ? ' on' : ''); live.textContent = liveNow ? 'Live' : 'Idle';
      note.hidden = M.cur;
      if (!M.cur) {
        note.textContent = '';
        add(note, icon('history'), el('span', '', 'Turn ' + M.turn.n + (isFinite(M.turn.at) ? ' started ' + when(M.turn.at) : '') + (M.turn.prompt ? ' · ' + one(M.turn.prompt, 90) : '') + '. Only the work of that turn is shown.'));
        var back = el('button', 'ap-link', 'Back to now'); back.type = 'button'; back.addEventListener('click', function () { S.turn = null; S.sig = ''; render(); });
        note.appendChild(back);
      }
      var items = outlineItems(M);
      var sig = JSON.stringify([items, S.exp, S.sel, S.node && sheet(), pane.className]);
      if (sig !== S.sig) { S.sig = sig; drawOutline(items); }
      renderHistHead();
    }

    var flat = [];
    function drawOutline(items) {
      flat = [];
      var hadFocus = outline.contains(document.activeElement);
      var top = outline.scrollTop;
      var tree = el('ul', 'ap-ul ap-root'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Agent tree');
      items.forEach(function (it) { tree.appendChild(rowOf(it, 1, null)); });
      outline.textContent = ''; outline.appendChild(tree);
      if (!flat.some(function (f) { return f.key === S.focus; })) S.focus = 'main';
      var fr = byKey(S.focus); if (fr) { fr.tabIndex = 0; if (hadFocus || S.refocus) fr.focus({ preventScroll: false }); }
      S.refocus = false;
      outline.scrollTop = top;
    }
    function byKey(k) { var rows = outline.querySelectorAll('.ap-row'); for (var i = 0; i < rows.length; i++) if (rows[i].dataset.key === k) return rows[i]; return null; }
    function rowOf(it, depth, parent) {
      var kids = it.kids || [];
      var has = kids.length > 0 || (it.group && it.kind !== 'note' && (it.lazy || it.empty != null));
      var open = has && isOpenKey(it);
      flat.push({ key: it.key, parent: parent, has: has, open: open, id: it.group ? null : it.id, it: it });
      var li = el('li', 'ap-li' + (depth === 1 ? ' ap-top' : '')); li.style.setProperty('--c', it.color || 'var(--faint)');
      var row = el('div', 'ap-row' + (it.group ? ' ap-grp' : '') + (it.kind === 'note' ? ' ap-noterow' : ''));
      row.setAttribute('role', 'treeitem'); row.dataset.key = it.key; row.dataset.kind = it.kind || '';
      if (it.status) row.dataset.status = st(it.status).id;
      row.setAttribute('aria-level', String(depth)); row.tabIndex = -1;
      if (has) row.setAttribute('aria-expanded', String(open));
      row.setAttribute('aria-selected', String(!it.group && !!it.id && S.sel === it.key));
      var chev = el('span', 'ap-chev'); if (has) { chev.dataset.tog = '1'; chev.appendChild(icon('right')); }
      var ico = { team: 'users', dgroup: 'fanout', wfgroup: 'fanout', wfrun: 'repeat', earlier: 'history', turngroup: 'history' }[it.kind];
      var mark = ico ? add(el('span', 'ap-ico'), icon(ico)) : el('span', 'ap-dot' + (it.kind === 'wfagent' ? ' sq' : ''));
      var tx = el('span', 'ap-tx'), l1 = el('span', 'ap-l1');
      add(l1, el('b', '', it.name));
      if (it.pick) add(l1, el('span', 'ap-pick', it.pick));
      if (it.gate) add(l1, gatePill(it.gate));
      add(l1, el('span', 'ap-sp'));
      if (it.status) add(l1, statusChip(it.status));
      else if (it.kind === 'fork') add(l1, el('span', 'ap-verdict' + (it.verdict === 'sharp' ? ' sharp' : ''), it.verdict === 'sharp' ? 'Sharp, followed' : 'Split, main decided'));
      add(tx, l1);
      if (it.brief || it.bits) {
        var l2 = el('span', 'ap-l2');
        if (it.brief) add(l2, el('span', 'ap-brief', it.brief));
        if (it.bits) add(l2, el('span', 'ap-bits', it.bits));
        add(tx, l2);
      }
      add(row, chev, mark, tx);
      li.appendChild(row);
      if (open) {
        var ul = el('ul', 'ap-ul'); ul.setAttribute('role', 'group');
        if (kids.length) kids.forEach(function (k) { ul.appendChild(rowOf(k, depth + 1, it.key)); });
        else ul.appendChild(rowOf({ key: it.key + ':none', kind: 'note', name: it.empty || 'Nothing here', color: it.color }, depth + 1, it.key));
        li.appendChild(ul);
      }
      return li;
    }
    /** Open by default: the main session, the branches, a worker with children
     *  and a workflow run that is still moving; everything else starts folded. */
    function isOpenKey(it) {
      var v = S.exp[it.key];
      if (v === 1) return true;
      if (v === 0) return false;
      return it.kind === 'sub' || (it.kind === 'wfrun' && it.status === 'run' && !it.lazy);
    }
    function toggle(k) {
      var f = flat.filter(function (x) { return x.key === k; })[0];
      S.exp[k] = f && isOpenKey(f.it) ? 0 : 1;
      S.focus = k; S.refocus = true; S.sig = '';
      if (S.exp[k] && f && f.it.kind === 'wfrun' && f.it.lazy && o.loadRun) o.loadRun(f.it.runId);
      render();
    }
    function activate(k) {
      var f = flat.filter(function (x) { return x.key === k; })[0]; if (!f) return;
      S.focus = k;
      if (f.id) { S.sel = k; openNode(f.id, f.it); }
      else if (f.has) toggle(k);
    }
    outline.addEventListener('click', function (e) {
      var row = e.target.closest('.ap-row'); if (!row) return;
      var k = row.dataset.key;
      if (e.target.closest('[data-tog]')) return toggle(k);
      activate(k);
    });
    outline.addEventListener('keydown', function (e) {
      var row = e.target.closest('.ap-row'); if (!row) return;
      var k = row.dataset.key, i = -1;
      for (var j = 0; j < flat.length; j++) if (flat[j].key === k) i = j;
      var f = flat[i];
      var go = function (j) { var t = flat[j]; if (!t) return; S.focus = t.key; outline.querySelectorAll('.ap-row').forEach(function (r) { r.tabIndex = -1; }); var r2 = byKey(t.key); if (r2) { r2.tabIndex = 0; r2.focus(); } };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(flat.length - 1);
      else if (e.key === 'ArrowRight') { if (f.has && !f.open) toggle(k); else if (f.has) go(i + 1); }
      else if (e.key === 'ArrowLeft') { if (f.has && f.open) toggle(k); else if (f.parent) { for (var p = 0; p < flat.length; p++) if (flat[p].key === f.parent) go(p); } }
      else if (e.key === 'Enter' || e.key === ' ') activate(k);
      else return;
      e.preventDefault();
    });

    // ---- one node's history ----
    var H = null; // {id, it, cache}
    var histCache = {};
    function openNode(id, it) {
      S.node = id; S.tab = 'conv'; H = { id: id, it: it }; S.sig = '';
      hist.hidden = false; render(); drawHistory(true);
    }
    function closeNode() {
      S.node = null; H = null; hist.hidden = true; hist.textContent = ''; S.sel = null; S.sig = ''; S.refocus = true; render();
    }
    /** The node as it is NOW (the outline refreshes under an open history). */
    function liveItem() {
      if (!H || !S.M) return H && H.it;
      var found = null;
      (function walk(list) { list.forEach(function (x) { if (found) return; if (x.id === H.id && !x.group) found = x; if (x.kids) walk(x.kids); }); })(outlineItems(S.M));
      return found || H.it;
    }
    function renderHistHead() {
      if (!H) return;
      var it = liveItem(); H.it = it;
      var chip = hist.querySelector('.ap-hh .ap-st');
      if (chip && it.status) chip.replaceWith(statusChip(it.status));
      if (it.status === 'run' && Date.now() - (H.polled || 0) > 4500) { H.polled = Date.now(); loadBody(false); }
    }

    function stats(items) {
      var dl = el('dl', 'ap-stats');
      items.forEach(function (x) { var d = el('div'); if (x[2]) d.title = x[2]; add(d, el('dt', '', x[0]), el('dd', '', x[1] || '—')); dl.appendChild(d); });
      return dl;
    }
    function drawHistory(fresh) {
      if (!H) return;
      var it = H.it, data = S.data || {}, t = data.tree || {};
      var drill = pane.classList.contains('ap-drill');
      H.drawn = true; H.drill = drill;
      var box = el('div', 'ap-hwrap'); box.style.setProperty('--c', it.color || 'var(--faint)');
      var hh = el('header', 'ap-hh');
      if (drill) { var bk = el('button', 'ap-ib'); bk.type = 'button'; bk.setAttribute('aria-label', 'Back to the tree'); bk.title = 'Back to the tree'; bk.appendChild(icon('left')); bk.addEventListener('click', closeNode); hh.appendChild(bk); }
      hh.appendChild(el('span', 'ap-dot' + (it.kind === 'wfagent' ? ' sq' : '')));
      var hm = el('div', 'ap-hm'); add(hm, el('div', 'ap-hn', it.kind === 'sub' ? it.name + ' · ' + (it.raw.description || '') : it.name));
      var meta = el('div', 'ap-hmeta'); if (it.status) meta.appendChild(statusChip(it.status)); if (it.brief && it.kind !== 'sub') meta.appendChild(el('span', '', it.brief));
      hm.appendChild(meta); hh.appendChild(hm);
      if (!drill) { var cx = el('button', 'ap-ib'); cx.type = 'button'; cx.setAttribute('aria-label', 'Close this history'); cx.title = 'Close this history'; cx.appendChild(icon('x')); cx.addEventListener('click', closeNode); hh.appendChild(cx); }
      box.appendChild(hh);
      var body = el('div', 'ap-hbody'); body.id = 'agentPaneHistBody';
      var foot = null;
      if (it.kind === 'sub' || it.kind === 'wfagent') {
        var s = it.raw, u = s.usage;
        box.appendChild(stats([['Tokens', u ? tok(usageTok(u)) : '—'], ['Cost', it.kind === 'wfagent' ? 'Not listed' : (engine.costLabel && engine.costLabel(s.cost)) || (u ? 'Not priced' : '—'), 'Tokens are recorded; not every model has a list price'], ['Time', dur(s.startedAt, s.endedAt) || '—'], ['Status', st(it.status).label]]));
        var tabs = el('div', 'ap-tabs'); tabs.setAttribute('role', 'tablist');
        [['conv', 'Conversation'], ['brief', 'Brief'], ['result', 'Result']].forEach(function (p) {
          var b = el('button', '', p[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = p[0]; b.setAttribute('aria-selected', String(S.tab === p[0])); b.tabIndex = S.tab === p[0] ? 0 : -1;
          b.addEventListener('click', function () { S.tab = p[0]; drawHistory(false); });
          tabs.appendChild(b);
        });
        tabs.addEventListener('keydown', function (e) {
          var order = ['conv', 'brief', 'result'], i = order.indexOf(S.tab);
          var j = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : -1; if (j < 0) return;
          e.preventDefault(); S.tab = order[j]; drawHistory(false); var b = hist.querySelector('[data-tab=' + order[j] + ']'); if (b) b.focus();
        });
        box.appendChild(tabs);
      } else if (it.kind === 'delegate') {
        var d = it.raw || {};
        var rep = d.lastReport;
        if (rep) {
          var card = el('div', 'ap-report'); var rh = el('div', 'ap-rph');
          if (rep.gate) rh.appendChild(gatePill(rep.gate));
          rh.appendChild(el('span', 'ap-faint', 'Latest report · ' + when(ms(rep.at))));
          add(card, rh, el('p', '', one(rep.text, 600)));
          box.appendChild(card);
        }
        foot = el('form', 'ap-send');
        var inp = el('input'); inp.type = 'text'; inp.placeholder = 'Message ' + (d.role || 'the delegate') + '…'; inp.setAttribute('aria-label', 'Message ' + (d.role || 'the delegate'));
        var sendB = el('button', 'ap-btn pri', 'Send'); sendB.type = 'submit';
        var stopB = el('button', 'ap-btn'); stopB.type = 'button'; add(stopB, icon('stop'), el('span', '', 'Stop')); stopB.disabled = delegateStatus(d) !== 'run';
        var termB = el('button', 'ap-btn'); termB.type = 'button'; add(termB, icon('console'), el('span', '', 'Terminal')); termB.title = 'Open its transcript in the terminal view';
        add(foot, inp, sendB, stopB, termB);
        foot.addEventListener('submit', function (e) { e.preventDefault(); var v = inp.value.trim(); if (!v || !engine.messageDelegate) return; inp.value = ''; engine.messageDelegate(d.id, v); if (engine.notify) engine.notify('Sent to ' + d.role + '.'); });
        stopB.addEventListener('click', function () { if (engine.stopDelegate) engine.stopDelegate(d.id); stopB.disabled = true; });
        termB.addEventListener('click', function () { if (engine.openDelegate) engine.openDelegate(d.id, d.role); });
      } else if (it.kind === 'main') {
        var m = t.main || {}, lt = m.lastTurn || {};
        box.appendChild(stats([['Model', modelName(m.model) || 'Default'], ['Effort', (m.effort || 'default') + (m.pickedBy ? ' · ' + (m.pickedBy === 'openai' ? 'Decisions' : 'Jev') : '')], ['Steps', lt.steps != null ? String(lt.steps) : '—'], ['Last turn', lt.durationMs != null ? dur(0, lt.durationMs) : '—']]));
      } else if (it.kind === 'jev') {
        var fk = t.forks || {};
        box.appendChild(stats([['Forks', String(fk.total || 0)], ['Sharp', String(fk.sharp || 0)], ['Split', String(fk.split || 0)], ['Picks', String((t.picks || []).length)]]));
      } else if (it.kind === 'advisor') {
        var a = t.advisor || {};
        box.appendChild(stats([['Calls', String((a.calls || []).length)], ['Model', modelName(a.model) || '—'], ['Kind', a.kind === 'claude' ? 'Claude, encrypted' : 'ChatGPT, gateway'], ['Per turn', a.kind === 'claude' ? 'model decides' : 'max 3']]));
      }
      box.appendChild(body);
      if (foot) box.appendChild(foot);
      hist.textContent = ''; hist.appendChild(box);
      if (drill) box.classList.add('ap-slide');
      paintBody();
      if (fresh || !cacheOf().loaded) loadBody(false);
    }
    function cacheOf() { var k = H.id; return histCache[k] || (histCache[k] = { rows: [], cursor: 0, done: true, loaded: false, sig: '' }); }
    function ctxQ() { var c = engine.current(); return c ? '?projectId=' + encodeURIComponent(c.projectId) + '&sessionId=' + encodeURIComponent(c.sessionId) : null; }
    function loadBody(older) {
      if (!H) return;
      var q = ctxQ(); if (!q) return;
      var it = H.it, c = cacheOf(), id = H.id, url = null, kind = it.kind;
      if (kind === 'sub') url = '/api/conversations/subagent-history' + q + '&agentId=' + encodeURIComponent(it.raw.agentId) + '&limit=100';
      else if (kind === 'wfagent') url = '/api/conversations/workflow-history' + q + '&runId=' + encodeURIComponent(it.run.runId) + '&agentId=' + encodeURIComponent(it.raw.agentId) + '&limit=100';
      else if (kind === 'delegate') url = '/api/conversations/raw-page' + q + '&delegateId=' + encodeURIComponent(it.raw.id) + '&limit=120';
      else if (kind === 'jev') url = 'jev';
      else if (kind === 'advisor') url = (S.data.tree || {}).provider === 'codex' ? '/api/conversations/advisor-consultations' + q : null;
      if (!url) { c.loaded = true; paintBody(); return; }
      if (older) { if (c.done) return; url += (kind === 'delegate' ? '&before=' : '&before=') + c.cursor; }
      else if (c.olderLoaded && (kind === 'sub' || kind === 'wfagent')) return; // the reader scrolled back; do not yank it
      var p = url === 'jev'
        ? Promise.all([o.getJson('/api/conversations/jev-forks' + q).catch(function () { return []; }), o.getJson('/api/conversations/jev-decisions' + q).catch(function () { return []; })]).then(function (r) { return { forks: r[0] || [], picks: r[1] || [] }; })
        : o.getJson(url);
      p.then(function (page) {
        if (!H || H.id !== id) return;
        var sig = JSON.stringify(page);
        if (!older && sig === c.sig) return;
        if (!older) c.sig = sig;
        if (kind === 'sub' || kind === 'wfagent') {
          c.rows = older ? (page.rows || []).concat(c.rows) : (page.rows || []);
          c.cursor = page.cursor; c.done = page.done !== false; if (older) c.olderLoaded = true;
        } else if (kind === 'delegate') {
          var ents = page.entries || [];
          c.rows = older ? ents.concat(c.rows) : ents; c.cursor = page.start; c.done = page.done !== false || !page.start; c.provider = page.provider;
          if (older) c.olderLoaded = true;
        } else c.data = page;
        c.loaded = true; paintBody(older);
      }).catch(function (e) { if (H && H.id === id) { c.error = e.message; c.loaded = true; paintBody(); } });
      if (kind === 'delegate' && !older) o.loadReports && o.loadReports();
    }
    function paintBody(keepTop) {
      var body = document.getElementById('agentPaneHistBody'); if (!body || !H) return;
      var it = H.it, c = cacheOf(), t = (S.data || {}).tree || {};
      var atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
      var h0 = body.scrollHeight, top0 = body.scrollTop;
      body.textContent = '';
      if (c.error) body.appendChild(el('p', 'ap-empty', 'Could not load: ' + c.error));
      if (it.kind === 'sub' || it.kind === 'wfagent') {
        var s = it.raw;
        if (S.tab === 'brief') {
          var brief = s.brief || (it.kind === 'wfagent' ? s.brief : '');
          body.appendChild(brief ? doc(brief, 'Spawned ' + when(ms(s.startedAt)) + (s.spawnedBy ? ' by ' + s.spawnedBy : it.kind === 'wfagent' ? ' by workflow ' + (it.run.name || it.run.runId) : '')) : el('p', 'ap-empty', 'No brief was recorded.'));
        } else if (S.tab === 'result') {
          var res = s.result;
          var why = it.status === 'run' ? 'No result yet. Still working' + (dur(s.startedAt) ? ', ' + dur(s.startedAt) + ' so far' : '') + '.'
            : it.status === 'ended' ? 'Ended without a result: the turn finished and this agent never reported back.'
            : it.status === 'stopped' ? 'Stopped before it reported a result.'
            : it.status === 'failed' ? 'Failed; there is no result.'
            : it.kind === 'wfagent' && it.status === 'done' ? 'Finished. Its result went back to the run\'s journal.'
            : 'No result has been recorded.';
          body.appendChild(res ? doc(res, 'Returned ' + when(ms(s.endedAt))) : el('p', 'ap-empty', why));
        } else {
          if (!c.done && c.rows.length) { var ol = el('button', 'ap-link ap-older', 'Load earlier messages'); ol.type = 'button'; ol.addEventListener('click', function () { loadBody(true); }); body.appendChild(ol); }
          var rows = el('div', 'thread ap-rows');
          if (c.rows.length && engine.renderRows) { engine.renderRows(rows, c.rows, (S.data.tree || {}).provider); body.appendChild(rows); }
          else body.appendChild(el('p', 'ap-empty', c.loaded ? 'No messages recorded yet.' : 'Loading…'));
          if (it.status === 'run') body.appendChild(add(el('p', 'ap-working'), el('span', 'ap-g ap-g-run'), el('span', '', 'working…')));
        }
      } else if (it.kind === 'delegate') {
        var reps = ((S.data || {}).reports || []).filter(function (r) { return r.delegateId === it.raw.id; });
        if (reps.length) {
          body.appendChild(el('div', 'ap-sect', 'Reports'));
          var rl = el('ol', 'ap-list');
          reps.slice().reverse().forEach(function (r) {
            var li = el('li', 'ap-card'); var top = el('div', 'ap-fch');
            add(top, el('time', '', when(ms(r.at))), el('b', '', 'Turn ' + (r.turn || '?')), r.gate ? gatePill(r.gate) : null);
            add(li, top, el('p', '', one(r.text, 400)));
            rl.appendChild(li);
          });
          body.appendChild(rl);
        }
        body.appendChild(el('div', 'ap-sect', 'Transcript'));
        if (!c.done && c.rows.length) { var ob = el('button', 'ap-link ap-older', 'Load earlier'); ob.type = 'button'; ob.addEventListener('click', function () { loadBody(true); }); body.appendChild(ob); }
        body.appendChild(c.rows.length ? rawList(c.rows) : el('p', 'ap-empty', c.loaded ? 'No transcript yet.' : 'Loading…'));
      } else if (it.kind === 'advisor') {
        var a = t.advisor || {};
        if (a.kind === 'claude' || t.provider !== 'codex') {
          body.appendChild(add(el('p', 'ap-note'), icon('sparkles'), el('span', '', 'Claude\'s advisor is Claude Code\'s own tool: the model decides when to call it and the advice comes back encrypted, so only its calls are listed.')));
          var cl = el('ol', 'ap-list');
          (a.calls || []).slice().reverse().forEach(function (x) { var li = el('li', 'ap-card'); add(li, add(el('div', 'ap-fch'), el('time', '', clockS(ms(x.at))), el('b', '', x.status === 'reviewed' ? 'Reviewed this step' : x.status || 'call'), x.error ? el('span', 'ap-verdict warn', x.error) : null)); cl.appendChild(li); });
          body.appendChild((a.calls || []).length ? cl : el('p', 'ap-empty', 'No advisor calls yet.'));
        } else {
          var cons = Array.isArray(c.data) && c.data.length ? c.data : (a.calls || []);
          var TRIG = { plan: 'Before a plan', stuck: 'An error repeats', done: 'Before done' };
          var ul = el('ol', 'ap-list');
          cons.slice().reverse().forEach(function (x) {
            var li = el('li', 'ap-card');
            var v = x.error ? 'error' : String(x.verdict || '').replace('_', ' ');
            add(li, add(el('div', 'ap-fch'), el('time', '', clockS(ms(x.at))), el('b', '', TRIG[x.trigger] || x.trigger || 'Consultation'), el('span', 'ap-verdict' + (x.error ? ' err' : x.verdict === 'adjust' || x.verdict === 'concern' ? ' warn' : ' sharp'), cap(v))));
            if (x.advice) li.appendChild(el('p', '', x.advice));
            if (x.error) li.appendChild(el('p', 'ap-faint', x.error));
            if (x.delivered && x.delivered !== 'none') li.appendChild(el('p', 'ap-faint', { steered: 'Steered into the running turn.', queued: 'Queued as a follow-up.', 'too-late': 'The turn had ended; not delivered.' }[x.delivered] || x.delivered));
            ul.appendChild(li);
          });
          body.appendChild(cons.length ? ul : el('p', 'ap-empty', c.loaded ? 'No consultations yet.' : 'Loading…'));
        }
      } else if (it.kind === 'jev') {
        var dj = c.data || { forks: ((t.forks || {}).recent || []), picks: t.picks || [] };
        body.appendChild(el('p', 'ap-note', (S.M && S.M.picker === 'Decisions' ? 'OpenAI Decisions' : 'Jev') + ' picks the model and effort per turn and answers small either-or questions. At 75% or more a fork is followed (sharp); below that the main model decides (split).'));
        body.appendChild(el('div', 'ap-sect', 'Picks'));
        var pl = el('ol', 'ap-list');
        (dj.picks || []).slice(-12).reverse().forEach(function (p) {
          var li = el('li', 'ap-card');
          var what = p.error ? 'error: ' + p.error : (p.notes && p.notes.length ? p.notes.join(', ') : [p.model ? modelName(p.model) : '', p.effort || ''].filter(Boolean).join(' · ') || 'unchanged');
          add(li, add(el('div', 'ap-fch'), el('time', '', when(ms(p.at))), el('b', '', String(what).replace(/->/g, '→')), p.team ? el('span', 'ap-faint', 'team ' + [p.team.model && modelName(p.team.model), p.team.effort].filter(Boolean).join(' · ')) : null));
          pl.appendChild(li);
        });
        body.appendChild((dj.picks || []).length ? pl : el('p', 'ap-empty', 'No picks yet.'));
        body.appendChild(el('div', 'ap-sect', 'Forks'));
        var fl = el('ol', 'ap-list');
        (dj.forks || []).filter(function (x) { return !/^report gate · /.test(x.question || ''); }).slice(-20).reverse().forEach(function (x) {
          var li = el('li', 'ap-card');
          add(li, add(el('div', 'ap-fch'), el('time', '', clockS(ms(x.at))), el('b', '', x.question), el('span', 'ap-verdict' + (x.verdict === 'sharp' ? ' sharp' : ''), x.verdict === 'sharp' ? 'Sharp' : 'Split')));
          if (x.options && x.options.length) { var ops = el('div', 'ap-opts'); x.options.forEach(function (op) { var sp = el('span', 'ap-opt' + (op === x.choice ? ' on' : '')); if (op === x.choice) sp.appendChild(icon('check')); sp.appendChild(document.createTextNode(op)); ops.appendChild(sp); }); li.appendChild(ops); }
          var bar = el('div', 'ap-fconf'), meter = el('span', 'ap-bar' + (x.verdict === 'sharp' ? ' sharp' : '')), fill = el('i'); fill.style.width = Math.round(Math.max(0, Math.min(1, x.confidence || 0)) * 100) + '%';
          var mk = el('em'); mk.title = '75%: followed from here'; add(meter, fill, mk); add(bar, meter, el('span', 'ap-faint', x.confidence == null ? '—' : pct(x.confidence)));
          li.appendChild(bar);
          if (x.error) li.appendChild(el('p', 'ap-faint', x.error));
          fl.appendChild(li);
        });
        body.appendChild(fl.children.length ? fl : el('p', 'ap-empty', 'No forks yet.'));
      } else if (it.kind === 'main') {
        body.appendChild(el('p', 'ap-note', 'The main session plans and decides; its whole transcript is the chat itself.'));
        var acts = el('div', 'ap-acts');
        var sc = el('button', 'ap-btn', 'Scroll the chat to the latest'); sc.type = 'button'; sc.addEventListener('click', function () { if (engine.scrollChat) engine.scrollChat(); });
        var tv = el('button', 'ap-btn'); tv.type = 'button'; add(tv, icon('console'), el('span', '', 'Open terminal view')); tv.addEventListener('click', function () { if (engine.openTerminal) engine.openTerminal(); });
        add(acts, sc, tv); body.appendChild(acts);
        if (S.M && S.M.turns.length) {
          body.appendChild(el('div', 'ap-sect', 'Turns'));
          var tl = el('ol', 'ap-list');
          S.M.turns.slice().reverse().slice(0, 20).forEach(function (x) {
            var li = el('li', 'ap-card ap-turnrow'); var b = el('button', 'ap-turnbtn'); b.type = 'button';
            add(b, el('b', '', 'Turn ' + x.n), el('time', '', when(x.at)), el('span', 'ap-faint', one(x.prompt, 80)));
            b.addEventListener('click', function () { S.turn = x.last ? null : x.n; S.sig = ''; render(); });
            li.appendChild(b); tl.appendChild(li);
          });
          body.appendChild(tl);
        }
      }
      if (keepTop) body.scrollTop = top0 + body.scrollHeight - h0;
      else if (S.tab === 'conv' && (it.kind === 'sub' || it.kind === 'wfagent' || it.kind === 'delegate') && (atBottom || !c.olderLoaded)) body.scrollTop = body.scrollHeight;
    }
    function doc(text, foot) {
      var d = el('div', 'ap-doc');
      if (engine.renderMarkdown) { try { d.appendChild(engine.renderMarkdown(text)); } catch (e) { d.appendChild(el('p', '', text)); } }
      else d.appendChild(el('p', '', text));
      if (foot) d.appendChild(el('p', 'ap-faint', foot));
      return d;
    }
    /** A delegate's raw transcript entries, compact: prompts, text, tool calls, results. */
    function rawList(entries) {
      var ol = el('ol', 'ap-raw');
      entries.forEach(function (e) {
        var j = (e && e.line && typeof e.line === "object" ? e.line : e) || {};
        var at = ms(j.timestamp);
        var push = function (type, text) { if (!text) return; var li = el('li', 'ap-r ap-r-' + type); add(li, el('time', '', clockS(at)), el('span', 'ap-rg', { user: '❯', text: '•', tool: '●', result: '⎿', think: '✻', err: '✕' }[type] || '·'), el('span', 'ap-rx', one(text, 600))); ol.appendChild(li); };
        var msg = j.message, content = msg && msg.content;
        if (j.type === 'user' || j.type === 'assistant') {
          if (typeof content === 'string') push(j.type === 'user' ? 'user' : 'text', content);
          else (content || []).forEach(function (c) {
            if (c.type === 'text') push(j.type === 'user' ? 'user' : 'text', c.text);
            else if (c.type === 'thinking') push('think', c.thinking);
            else if (c.type === 'tool_use') push('tool', c.name + ' ' + JSON.stringify(c.input || {}));
            else if (c.type === 'tool_result') push(c.is_error ? 'err' : 'result', typeof c.content === 'string' ? c.content : (c.content || []).map(function (x) { return x.text || ''; }).join(' '));
          });
        } else if (j.type === 'response_item' && j.payload) {
          var p = j.payload;
          if (p.type === 'message') push(p.role === 'user' ? 'user' : 'text', (p.content || []).map(function (x) { return x.text || ''; }).join(' '));
          else if (p.type === 'function_call') push('tool', (p.name || 'call') + ' ' + (p.arguments || ''));
          else if (p.type === 'function_call_output') push('result', typeof p.output === 'string' ? p.output : JSON.stringify(p.output));
          else if (p.type === 'reasoning') push('think', (p.summary || []).map(function (x) { return x.text || ''; }).join(' '));
        } else if (j.type === 'event_msg' && j.payload && j.payload.message) push('text', j.payload.message);
        else if (j.type === 'item_completed' || (j.payload && j.payload.type === 'item_completed')) { var itm = (j.payload || j).item || {}; if (itm.text) push(itm.type === 'UserMessage' ? 'user' : 'text', itm.text); }
      });
      if (!ol.children.length) ol.appendChild(el('li', 'ap-empty', 'Nothing readable in this page of the transcript; open it in the terminal view for every entry.'));
      return ol;
    }

    return {
      el: pane,
      show: function () { pane.hidden = false; host.classList.add('ap-open'); layout(); S.sig = ''; render(); },
      hide: function () { pane.hidden = true; host.classList.remove('ap-open'); },
      isShown: function () { return !pane.hidden; },
      /** A new conversation: forget the turn, the open history and its caches. */
      reset: function () { S.data = null; S.turn = null; S.sel = null; S.node = null; S.sig = ''; S.focus = 'main'; H = null; histCache = {}; hist.hidden = true; hist.textContent = ''; outline.textContent = ''; outline.appendChild(el('p', 'ap-empty', 'Loading…')); layout(); },
      update: function (data) { S.data = data; render(); },
      error: function (msg) { if (!S.data) { outline.textContent = ''; outline.appendChild(el('p', 'ap-empty', msg)); } },
      empty: function (msg) { S.data = null; outline.textContent = ''; outline.appendChild(el('p', 'ap-empty', msg)); },
      model: function () { return S.M; },
      /** Reports arrived for an open delegate history. */
      repaint: function () { if (H && H.it.kind === 'delegate') paintBody(); },
    };
  };
})();

(function () {
  'use strict';
  var FAST_MS = 3000, SLOW_MS = 15000, SUBS_MIN_MS = 5000, RUNS_MIN_MS = 4000, REPORTS_MIN_MS = 8000, LOG_MAX = 15, FORKS_SHOWN = 4;
  var EVENTS = ['jev_fork', 'jev_decision', 'advisor_call', 'advisor_consult', 'delegate_update', 'delegate_report', 'turn_state', 'session_done'];
  var EFFORT_LEVEL = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
  var CHECKPOINTS = [['plan', 'before a plan'], ['stuck', 'error repeats'], ['done', 'before done']];
  var VERDICT = { proceed: 'proceed', adjust: 'adjust', looks_good: 'looks good', concern: 'concern' };
  // Every value the server can send, each with its own glyph and words.
  var SUB_STATUS = { running: ['◐', 'running'], done: ['✓', 'done'], ended: ['⊘', 'ended · no result'], stopped: ['■', 'stopped'], failed: ['✕', 'failed'], unknown: ['◌', 'status unknown'] };
  var DG_STATUS = { working: 'working', idle: 'idle', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
  var GATE = { done: 'done', needs_orchestrator: 'needs orchestrator', needs_human: 'needs you', blocked: 'blocked' };
  var SUB_RANK = { running: 0, done: 2, ended: 3, stopped: 4, failed: 5, unknown: 6 };

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
  function subStatusKey(s) { return SUB_STATUS[s] ? s : 'unknown'; }
  /** Working first: running, done, ended, stopped, failed, unknown; ties keep order. */
  function workingFirst(list) {
    return list.map(function (s, i) { return [s, i]; })
      .sort(function (a, b) { return (SUB_RANK[subStatusKey(a[0].status)]) - (SUB_RANK[subStatusKey(b[0].status)]) || a[1] - b[1]; })
      .map(function (p) { return p[0]; });
  }

  window.createAgentTree = function (engine) {
    var Model = window.AgentTreeModel;
    var main = document.querySelector('body > main');
    var root = document.createElement('section');
    root.id = 'atree'; root.className = 'term atree'; root.hidden = true; root.setAttribute('aria-label', 'Agent tree');
    var head = add(el('div', 'term-head'), el('strong', '', 'Agent tree'));
    var title = put(head, el('span', 'at-title')); title.id = 'atreeTitle';
    add(head, el('span', 'sp'));
    var live = put(head, el('span', 'term-live', '● live')); live.title = 'refreshes while open';
    var collapseBtn = put(head, el('button', 'term-back at-collapse', 'Collapse')); collapseBtn.type = 'button'; collapseBtn.id = 'atreeCollapse';
    collapseBtn.title = 'Back to the docked tree beside the chat';
    var closeBtn = put(head, el('button', 'term-back', 'Close')); closeBtn.type = 'button'; closeBtn.id = 'atreeClose';
    var body = el('div', 'at-body'); body.id = 'atreeBody';
    add(root, head, body);
    var scroll = main.querySelector('.scroll');
    scroll.parentNode.insertBefore(root, scroll.nextSibling);
    collapseBtn.addEventListener('click', function () { collapse(); });
    closeBtn.addEventListener('click', function () { close(); });

    // paneOpen: the docked outline; expanded: the console over the conversation.
    var paneOpen = false, expanded = false, key = '', timer = null, debounce = null, subsTimer = null;
    var tree = null, runs = [], runAgents = {}, reports = [], error = '', earlierOpen = false;
    var treeBusy = false, runsAt = 0, runsBusy = false, reportsAt = 0, subsAt = 0, wantRuns = {};

    var pane = typeof window.createAgentPane === 'function' ? window.createAgentPane({
      engine: engine,
      getJson: getJson,
      onExpand: function () { expand(); },
      onClose: function () { close(); },
      loadRun: function (runId) { wantRuns[runId] = 1; loadRuns(true); },
      loadReports: function () { loadReports(true); },
    }) : null;

    function open() { return paneOpen || expanded; }
    function cur() { return engine.current(); }
    function keyOf(c) { return c ? c.projectId + '::' + c.sessionId : ''; }
    function q(c) { return '?projectId=' + encodeURIComponent(c.projectId) + '&sessionId=' + encodeURIComponent(c.sessionId); }
    function getJson(path) { return engine.api(path).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'request failed'); return j; }); }); }
    function subs() { return (engine.subagents && engine.subagents()) || []; }
    function busyNow() {
      return !!(tree && tree.main && (tree.main.running || tree.main.background)) || subs().some(function (s) { return s.status === 'running'; })
        || runs.some(function (r) { return Model && Model.runStatus(r) === 'run'; }) || !!(tree && (tree.delegates || []).some(function (d) { return d.working || d.status === 'working'; }));
    }

    function pressed() { ['chatAgentTree', 'atreeBtn'].forEach(function (id) { var b = document.getElementById(id); if (b) b.setAttribute('aria-pressed', open() ? 'true' : 'false'); }); }
    function remember() { try { if (expanded) localStorage.setItem('x056_agent_tree', 'expanded'); else if (paneOpen) localStorage.setItem('x056_agent_tree', '1'); else localStorage.removeItem('x056_agent_tree'); } catch (e) {} }
    function toggle() { if (open()) close(); else show(); }
    /** The docked pane beside the chat. */
    function show() {
      var was = open();
      if (expanded) { expanded = false; root.hidden = true; main.classList.remove('atree-open'); }
      paneOpen = true; if (pane) pane.show();
      pressed(); remember();
      if (!was) reload(); else draw();
    }
    /** The console view over the whole conversation component. */
    function expand() {
      var was = open();
      if (engine.onExpand) engine.onExpand(); // closes the terminal: one view takes the conversation's place
      expanded = true; root.hidden = false; main.classList.add('atree-open');
      if (pane) pane.hide();
      pressed(); remember();
      if (!was) reload(); else draw();
    }
    function collapse() {
      if (!expanded) return;
      expanded = false; root.hidden = true; main.classList.remove('atree-open');
      paneOpen = true; if (pane) pane.show();
      pressed(); remember(); draw();
    }
    function close() {
      expanded = false; paneOpen = false; root.hidden = true; main.classList.remove('atree-open');
      if (pane) pane.hide();
      pressed(); remember(); stop();
    }
    function stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (subsTimer) { clearTimeout(subsTimer); subsTimer = null; }
    }
    function schedule() { if (timer) clearTimeout(timer); timer = open() ? setTimeout(tick, busyNow() ? FAST_MS : SLOW_MS) : null; }
    function tick() {
      timer = null;
      if (!open()) return;
      if (keyOf(cur()) !== key) { reload(); return; }
      if (document.hidden) { schedule(); return; }
      refresh();
    }

    /** A different conversation, or a fresh open. */
    function reload() {
      stop();
      var c = cur();
      tree = null; runs = []; runAgents = {}; reports = []; error = ''; treeBusy = false; runsBusy = false; runsAt = 0; reportsAt = 0; wantRuns = {}; earlierOpen = false;
      key = keyOf(c);
      if (pane) pane.reset();
      if (!c) { if (pane) pane.empty('No conversation selected.'); render(); return; }
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
        draw();
        // One more read on the busy -> idle edge, so a missed session_done cannot leave rows "running".
        if (withSubs || busyNow() || wasBusy) wantSubs();
        loadRuns(withSubs);
        if ((t.delegates || []).length) loadReports(withSubs);
      }).catch(function (e) { if (myKey === key) { error = e.message; draw(); if (pane) pane.error('Could not load: ' + e.message); } })
        .then(function () { treeBusy = false; schedule(); });
    }
    /** The panel's subagent list, refreshed at most every 5 s. */
    function wantSubs() {
      if (subsTimer || !open() || !engine.refreshSubagents) return;
      var wait = SUBS_MIN_MS - (Date.now() - subsAt);
      if (wait > 0) { subsTimer = setTimeout(function () { subsTimer = null; wantSubs(); }, wait); return; }
      subsAt = Date.now();
      engine.refreshSubagents();
    }
    // The list is refetched on every conversation switch, so it is also the
    // surest sign the conversation on screen is not the one drawn.
    if (engine.onSubagents) engine.onSubagents(function () { if (!open()) return; if (keyOf(cur()) !== key) reload(); else draw(); });

    /** Workflow runs (Claude only; Codex answers none), and the agents of the
     *  runs that are open or live. */
    function loadRuns(force) {
      var c = cur(); if (!c || runsBusy) return;
      if (!force && Date.now() - runsAt < RUNS_MIN_MS) return;
      if (!force && !runs.some(function (r) { return Model.runStatus(r) === 'run'; }) && runsAt && !busyNow()) return;
      runsBusy = true; runsAt = Date.now();
      var myKey = key;
      getJson('/api/conversations/workflows' + q(c)).then(function (d) {
        if (myKey !== key) return;
        runs = (d && d.runs) || [];
        var ids = runs.filter(function (r) { return wantRuns[r.runId] || (Model.runStatus(r) === 'run' && runAgents[r.runId]); }).map(function (r) { return r.runId; });
        return Promise.all(ids.map(function (id) {
          return getJson('/api/conversations/workflows' + q(c) + '&runId=' + encodeURIComponent(id)).then(function (one) {
            if (myKey !== key) return;
            runAgents[id] = (one && one.agents) || [];
            delete wantRuns[id];
          }).catch(function () {});
        }));
      }).catch(function () { /* the next refresh retries */ }).then(function () { runsBusy = false; if (myKey === key) draw(); });
    }
    function loadReports(force) {
      var c = cur(); if (!c) return;
      if (!force && Date.now() - reportsAt < REPORTS_MIN_MS) return;
      reportsAt = Date.now();
      var myKey = key;
      getJson('/api/delegates/reports' + q(c)).then(function (r) {
        if (myKey !== key) return;
        reports = Array.isArray(r) ? r : [];
        draw(); if (pane) pane.repaint();
      }).catch(function () {});
    }

    function onEvent(kind, data) {
      if (!open() || EVENTS.indexOf(kind) < 0) return;
      var c = cur(); if (!c) return;
      data = data || {};
      if (data.sessionId ? data.sessionId !== c.sessionId : (data.projectId && data.projectId !== c.projectId)) return;
      var ended = kind === 'session_done' || kind === 'turn_state';
      if (kind === 'delegate_report') reportsAt = 0;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () { debounce = null; refresh(ended); }, 250);
    }

    function draw() {
      if (pane && paneOpen && !expanded && tree) pane.update({ tree: tree, subs: subs(), runs: runs, runAgents: runAgents, reports: reports });
      if (expanded) render();
    }

    // ---- the expanded console view ---------------------------------------------
    var lastSig = null;
    function render() {
      var list = subs();
      var sig = JSON.stringify([key, tree, list, runs, error, earlierOpen]);
      if (sig === lastSig && body.firstChild) return; // nothing changed: keep focus and scroll untouched
      lastSig = sig;
      var top = body.scrollTop;
      body.textContent = '';
      if (!key) { title.textContent = ''; add(body, el('p', 'at-empty', 'No conversation selected.')); return; }
      if (!tree) { title.textContent = ''; add(body, el('p', 'at-empty', error ? 'Could not load: ' + error : 'loading…')); return; }
      var t = tree, h = t.helpers || {}, team = t.team, adv = t.advisor || { on: false };
      var mainModel = modelName(t.main.model) || (t.provider === 'codex' ? 'ChatGPT' : 'Claude');
      title.textContent = mainModel.toUpperCase() + ' WORKS' + (adv.on ? ' · ' + modelName(adv.model).toUpperCase() + ' ON CALL' : '');

      // The current turn's workers (the pane's membership rule); the rest fold by turn.
      var turns = Model.turnsOf(t), turn = turns[turns.length - 1];
      var turnStart = turn.start;
      var thisTurn = workingFirst(list.filter(function (s) { return Model.inTurn(turn, ms(s.startedAt), isFinite(ms(s.endedAt)) ? ms(s.endedAt) : ms(s.updatedAt), s.status === 'running'); }));
      var M = Model.build({ tree: t, subs: list, runs: runs, runAgents: runAgents, reports: reports }, null, engine);
      var picker = h.router === 'decisions' ? 'decisions' : 'jev';
      var showForks = !!team || (t.forks && t.forks.total > 0);

      add(body, legend(t, mainModel, showForks, picker, list));
      var grid = put(body, el('div', 'at-grid' + (adv.on ? ' has-adv' : '')));
      if (adv.on) add(grid, advisorColumn(adv, turnStart));
      var flow = el('ol', 'at-flow'); flow.setAttribute('aria-label', 'Pipeline');
      add(grid, flow);
      add(flow, mainNode(t, mainModel));
      if (showForks) { add(flow, link()); add(flow, forkNode(t.forks, picker)); }
      var anyWorkers = list.length > 0 || (t.delegates || []).length > 0 || runs.length > 0;
      if (team || list.length) {
        add(flow, link(team ? 'delegate to subagents · ' : 'subagents', team ? teamLabel(team) : ''));
        add(flow, workersNode(thisTurn, M.earlier, t));
      }
      var liveRuns = runs.filter(function (r) { return Model.inTurn(turn, ms(r.startedAt), ms(r.updatedAt), Model.runStatus(r) === 'run'); });
      if (liveRuns.length) { add(flow, link('workflow runs')); add(flow, runsNode(liveRuns)); }
      if ((t.delegates || []).length) { add(flow, link(team || list.length ? '' : 'delegate to hidden workers')); add(flow, delegatesNode(t.delegates, t.gates || [])); }
      if (team || anyWorkers) { add(flow, link()); add(flow, backNode(t, mainModel)); }
      if (!h.advisor && !h.team && !h.router && !anyWorkers) {
        add(flow, el('li', 'at-hint', 'Turn on Advisor, Agent team or Jev from the ✦ button, or ask this conversation to delegate work.'));
      }
      add(body, logNode(t, thisTurn, turnStart));
      body.scrollTop = top;
    }

    function legend(t, mainModel, showForks, picker, list) {
      var ul = el('ul', 'at-legend'); ul.setAttribute('aria-label', 'Legend');
      var chip = function (cls, text) { var li = el('li', cls); add(li, el('i'), el('span', '', text)); return li; };
      add(ul, chip('main', mainModel.toLowerCase() + (t.main.effort ? ' · ' + t.main.effort : '')));
      if (t.team || list.length) add(ul, chip('sub', 'subagents' + (t.team ? ' · ' + (t.team.pickedBy && t.team.model ? modelName(t.team.model).toLowerCase() + ' · ' : '') + t.team.effort : '')));
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
      var k = subStatusKey(s.status);
      var li = el('li', 'at-card ' + k);
      var b = put(li, el('button', 'at-card-btn')); b.type = 'button';
      var st = SUB_STATUS[k];
      b.setAttribute('aria-label', (s.agentType || 'agent') + ', ' + st[1] + ': ' + (s.description || s.brief || ''));
      add(b, el('span', 'at-card-role', s.agentType || 'agent'));
      var lab = workerLabel(s, t); if (lab) add(b, el('span', 'at-card-model', lab));
      add(b, el('span', 'at-card-desc', one(s.description || s.brief || '', 60)));
      var sEl = put(b, el('span', 'at-card-status', st[0] + ' ' + st[1])); sEl.dataset.status = k;
      b.addEventListener('click', function () { if (engine.openSubagent) engine.openSubagent(s); });
      if (kids.length) {
        var ul = put(li, el('ul', 'at-kids')); ul.setAttribute('aria-label', 'spawned by ' + (s.agentType || 'agent'));
        kids.forEach(function (x) { add(ul, x); });
      }
      return li;
    }
    function workersNode(list, earlier, t) {
      var li = el('li', 'at-workers'); li.setAttribute('aria-label', 'Workers this turn');
      var ul = put(li, el('ul', 'at-cards'));
      // Nest by spawner: a child sits inside the card of the agent that spawned it.
      var byId = {}; list.forEach(function (s) { byId[s.agentId] = s; });
      var parentOf = function (s) {
        if (s.parentAgentId && byId[s.parentAgentId] && s.parentAgentId !== s.agentId) return s.parentAgentId;
        if (!s.spawnedBy || (s.spawnDepth || 1) <= 1) return null;
        if (byId[s.spawnedBy]) return s.spawnedBy;
        for (var i = 0; i < list.length; i++) if (list[i] !== s && (list[i].description === s.spawnedBy || list[i].agentType === s.spawnedBy)) return list[i].agentId;
        return null;
      };
      var kids = {};
      list.forEach(function (s) { var p = parentOf(s); if (p) (kids[p] = kids[p] || []).push(s); });
      var build = function (s, seen) {
        seen[s.agentId] = true;
        return subCard(s, t, (kids[s.agentId] || []).filter(function (x) { return !seen[x.agentId]; }).map(function (x) { return build(x, seen); }));
      };
      var seen = {};
      list.filter(function (s) { return !parentOf(s); }).forEach(function (s) { add(ul, build(s, seen)); });
      list.forEach(function (s) { if (!seen[s.agentId]) add(ul, build(s, seen)); });
      if (!list.length) add(ul, el('li', 'at-none', 'no workers this turn'));
      var n = earlier.reduce(function (a, e) { return a + e.workers.length; }, 0);
      if (n > 0) {
        var fold = put(li, el('div', 'at-earlier' + (earlierOpen ? ' open' : '')));
        var btn = put(fold, el('button', 'at-earlier-btn', (earlierOpen ? '▾ ' : '▸ ') + '+' + n + ' earlier')); btn.type = 'button'; btn.id = 'atreeEarlier';
        btn.setAttribute('aria-expanded', String(earlierOpen)); btn.title = 'workers from earlier turns, grouped by turn';
        btn.addEventListener('click', function () { earlierOpen = !earlierOpen; lastSig = null; render(); var b2 = document.getElementById('atreeEarlier'); if (b2) b2.focus(); });
        if (earlierOpen) {
          earlier.forEach(function (e) {
            var g = put(fold, el('div', 'at-eg'));
            add(g, el('div', 'at-egh', (e.turn.n == null ? 'before this turn' : 'turn ' + e.turn.n) + (isFinite(e.turn.at) ? ' · ' + clock(e.turn.at) : '') + (e.turn.prompt && e.turn.n != null ? ' · ' + one(e.turn.prompt, 60) : '')));
            var gl = put(g, el('ul', 'at-eg-list'));
            e.workers.forEach(function (w) {
              var r = put(gl, el('li', 'at-er'));
              var s = Model.status(w.status);
              var b = put(r, el('button', 'at-er-btn')); b.type = 'button';
              add(b, el('span', 'role', w.name), el('span', 'desc', w.brief || ''), el('span', 'st st-' + s.key, s.label));
              b.dataset.status = s.id;
              b.addEventListener('click', function () {
                if (w.kind === 'sub' && engine.openSubagent) engine.openSubagent(w.raw);
                else if (w.kind === 'delegate' && engine.openDelegate) engine.openDelegate(w.id.slice(3), w.name);
              });
            });
            if (!e.workers.length) add(gl, el('li', 'at-none', 'no workers'));
          });
        }
      }
      return li;
    }

    function runsNode(list) {
      var li = el('li', 'at-node wf'); li.setAttribute('aria-label', 'Workflow runs');
      add(li, add(el('div', 'at-node-title spread'), el('span', '', 'workflow runs'), el('span', 'at-faint', list.length + ' this turn')));
      var ul = put(li, el('ul', 'at-dgs'));
      Model.bySt(list.map(function (r) { return { r: r, status: Model.runStatus(r) }; })).forEach(function (x) {
        var r = x.r, s = Model.status(x.status);
        var rr = put(ul, el('li', 'at-dg'));
        var b = put(rr, el('div', 'at-dg-btn'));
        add(b, el('span', 'role', r.name || r.runId), el('span', 'model', (r.finished || 0) + ' of ' + (r.started || 0) + ' agents'), el('span', 'st st-' + s.key, s.label));
      });
      return li;
    }

    function delegatesNode(list, gates) {
      var li = el('li', 'at-node dg'); li.setAttribute('aria-label', 'Delegates');
      var hd = put(li, el('div', 'at-node-title spread'));
      add(hd, el('span', '', 'delegates · hidden workers'));
      if (gates.length) add(hd, el('span', 'at-faint', 'report gate · ' + gates.length));
      var ul = put(li, el('ul', 'at-dgs'));
      Model.bySt(list.map(function (d) { return { d: d, status: Model.delegateStatus(d) }; })).forEach(function (x) {
        var d = x.d;
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

    function backNode(t) {
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

    function logNode(t, thisTurn, turnStart) {
      var ev = [];
      var push = function (at, tag, cls, text) { at = ms(at); if (isFinite(at)) ev.push({ at: at, tag: tag, cls: cls, text: text }); };
      thisTurn.forEach(function (s) {
        push(s.startedAt, s.agentType || 'agent', 'sub', 'started · ' + one(s.description || s.brief, 70));
        if (s.endedAt) push(s.endedAt, s.agentType || 'agent', 'sub', SUB_STATUS[subStatusKey(s.status)][1] + ' · ' + one(s.description || s.brief, 60));
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

    var api = {
      toggle: toggle, show: show, close: close, expand: expand, collapse: collapse,
      isOpen: function () { return open(); }, isExpanded: function () { return expanded; }, isPaneOpen: function () { return paneOpen && !expanded; },
      conversationChanged: function () { if (open()) reload(); }, event: onEvent,
    };
    try {
      var saved = localStorage.getItem('x056_agent_tree');
      if (saved === 'expanded') setTimeout(expand, 0); else if (saved === '1') setTimeout(show, 0);
    } catch (e) {}
    return api;
  };
})();
