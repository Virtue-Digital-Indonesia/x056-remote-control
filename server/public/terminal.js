/*
 * Terminal view: the whole session as a CLI would show it.
 *
 * Reads the conversation's own transcript (GET /api/conversations/raw-page,
 * paged by byte offset) and renders every entry -- prompts, text, thinking,
 * each tool call with its input, each result, advisor consultations, system
 * lines -- plus Jev's per-turn model/effort decisions merged in by time.
 * While open it tails the file every 2 s, so a running turn streams in.
 * Click a line to see the raw entry; a cut entry can be loaded in full.
 */
(function () {
  'use strict';
  var POLL_MS = 2000;

  window.createTerminalView = function (engine) {
    var main = document.querySelector('body > main');
    var root = document.createElement('section');
    root.id = 'term'; root.className = 'term hide-meta'; root.hidden = true; root.setAttribute('aria-label', 'Terminal view');
    root.innerHTML =
      '<div class="term-head">' +
        '<strong>Terminal</strong><span class="term-meta" id="termMeta"></span>' +
        '<button type="button" class="term-back" id="termBack" hidden>Back to the conversation</button><span class="sp"></span>' +
        '<span class="term-jev" id="termJev" hidden></span>' +
        '<label class="term-opt"><input type="checkbox" id="termShowMeta"> metadata</label>' +
        '<span class="term-live" id="termLive" title="updates every 2 seconds">● live</span>' +
      '</div>' +
      '<div class="term-body" id="termBody"><button type="button" class="term-older" id="termOlder" hidden>Load older</button><div id="termLines"></div></div>';
    var scroll = main.querySelector('.scroll');
    scroll.parentNode.insertBefore(root, scroll.nextSibling);
    var $ = function (id) { return document.getElementById(id); };
    var body = $('termBody'), linesEl = $('termLines');

    var open = false, key = '', provider = 'claude', start = 0, end = 0, done = true, timer = null, busy = false, jev = [], jevShown = {};
    // A delegate's transcript instead of the conversation's own (Delegates bar).
    var delegate = null;

    $('termShowMeta').addEventListener('change', function () { root.classList.toggle('hide-meta', !this.checked); });
    $('termOlder').addEventListener('click', loadOlder);

    function cur() { return engine.current(); }
    function q(c, extra) { return '?projectId=' + encodeURIComponent(c.projectId) + '&sessionId=' + encodeURIComponent(c.sessionId) + (delegate ? '&delegateId=' + encodeURIComponent(delegate.id) : '') + (extra || ''); }
    // Side records (Jev, advisor, forks) belong to the conversation, not to a delegate.
    function side(path, c) { return delegate ? Promise.resolve([]) : getJson(path + q(c)).catch(function () { return []; }); }
    $('termBack').addEventListener('click', function () { delegate = null; reload(); });
    function getJson(path) { return engine.api(path).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'request failed'); return j; }); }); }

    function toggle() { if (open) close(); else show(); }
    function pressed(on) { ['chatTerminal', 'termBtn'].forEach(function (id) { var b = document.getElementById(id); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
    function show() {
      open = true; root.hidden = false; main.classList.add('term-open'); pressed(true);
      try { localStorage.setItem('x056_terminal', '1'); } catch (e) {}
      reload();
    }
    function close() {
      delegate = null;
      open = false; root.hidden = true; main.classList.remove('term-open'); stop(); pressed(false);
      try { localStorage.removeItem('x056_terminal'); } catch (e) {}
    }
    function stop() { if (timer) { clearTimeout(timer); timer = null; } }

    /** A different conversation, or a fresh open: start over from the tail. */
    function reload() {
      stop();
      var c = cur();
      linesEl.textContent = ''; jevShown = {}; jev = []; start = end = 0; done = true;
      if (!c || !c.projectId || !c.sessionId) { key = ''; $('termMeta').textContent = 'No conversation selected'; return; }
      key = c.projectId + '::' + c.sessionId + (delegate ? '::' + delegate.id : '');
      $('termBack').hidden = !delegate;
      var myKey = key;
      $('termMeta').textContent = 'loading…';
      Promise.all([getJson('/api/conversations/raw-page' + q(c, '&limit=300')), side('/api/conversations/jev-decisions', c),
        side('/api/conversations/advisor-consultations', c), side('/api/conversations/turn-results', c), side('/api/conversations/jev-forks', c)])
        .then(function (res) {
          if (myKey !== key) return;
          var page = res[0]; jev = (res[1] || []).concat((res[2] || []).map(function (a) { return Object.assign({ kind: 'advisor' }, a); }), (res[3] || []).map(function (r) { return Object.assign({ kind: 'result' }, r); }), (res[4] || []).map(function (f) { return Object.assign({ kind: 'fork' }, f); })).sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
          provider = page.provider || 'claude';
          start = page.start; end = page.end; done = page.done;
          var firstTs = firstTimestamp(page.entries);
          var lines = page.entries.reduce(function (out, e) { return out.concat(entryLines(e)); }, []);
          lines = mergeJev(lines, jev.filter(function (d) { return done || !firstTs || d.at >= firstTs; }));
          linesEl.appendChild(renderLines(lines));
          meta(page);
          $('termOlder').hidden = done;
          body.scrollTop = body.scrollHeight;
          refreshJev();
          schedule();
        })
        .catch(function (e) { if (myKey === key) $('termMeta').textContent = 'Could not load: ' + e.message; });
    }

    function schedule() { stop(); if (open) timer = setTimeout(poll, POLL_MS); }
    function poll() {
      var c = cur();
      if (!open || !c || c.projectId + '::' + c.sessionId !== key) { if (open) reload(); return; }
      if (busy || document.hidden) { schedule(); return; }
      busy = true;
      var myKey = key;
      getJson('/api/conversations/raw-page' + q(c, '&after=' + end + '&limit=500')).then(function (page) {
        if (myKey !== key) return;
        if (page.size < end) { reload(); return; } // file replaced (compaction, new thread): start over
        end = page.end;
        if (page.entries.length) {
          var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
          var lines = page.entries.reduce(function (out, e) { return out.concat(entryLines(e)); }, []);
          linesEl.appendChild(renderLines(lines));
          meta(page);
          if (atBottom) body.scrollTop = body.scrollHeight;
        }
      }).catch(function () { /* a missed poll is retried */ }).then(function () { busy = false; schedule(); });
    }

    function loadOlder() {
      var c = cur(); if (!c || done) return;
      var btn = $('termOlder'); btn.disabled = true;
      var myKey = key, oldFirst = firstShownTs();
      getJson('/api/conversations/raw-page' + q(c, '&before=' + start + '&limit=300')).then(function (page) {
        if (myKey !== key) return;
        start = page.start; done = page.done;
        var firstTs = firstTimestamp(page.entries);
        var lines = page.entries.reduce(function (out, e) { return out.concat(entryLines(e)); }, []);
        lines = mergeJev(lines, jev.filter(function (d) { return (done || !firstTs || d.at >= firstTs) && (!oldFirst || d.at < oldFirst); }));
        var h = body.scrollHeight;
        linesEl.insertBefore(renderLines(lines), linesEl.firstChild);
        body.scrollTop += body.scrollHeight - h; // keep the reader's place
        btn.hidden = done;
      }).catch(function (e) { engine.notify && engine.notify('Could not load older lines. ' + e.message); })
        .then(function () { btn.disabled = false; });
    }

    function meta(page) {
      $('termMeta').textContent = (delegate ? 'Delegate ' + delegate.role + ' · ' : '') + (provider === 'codex' ? 'Codex rollout' : 'Claude transcript') + ' · ' + mb(page.size);
    }
    function refreshJev() {
      engine.api('/api/jev/status').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
        var el = $('termJev');
        if (!s || !s.configured) { el.hidden = true; return; }
        el.hidden = false;
        el.textContent = s.estimatedLeft !== undefined ? 'Jev ≈ $' + s.estimatedLeft.toFixed(4) + ' left' : 'Jev · $' + s.totalSpent.toFixed(4) + ' spent';
        el.title = (s.syncedAt ? 'Balance $' + s.balance + ' synced ' + new Date(s.syncedAt).toLocaleString() + '; ' : '') + s.callsSinceSync + ' call(s), $' + s.spentSinceSync.toFixed(6) + ' since sync. Metered by the gateway: TypeSafe has no balance API.';
      }).catch(function () {});
    }

    /** Live events from the gateway. */
    function onEvent(kind, data) {
      if ((kind !== 'jev_decision' && kind !== 'advisor_consult' && kind !== 'turn_result' && kind !== 'jev_fork') || !open || delegate) return;
      var c = cur(); if (!c || data.sessionId !== c.sessionId) return;
      if (kind === 'advisor_consult') data = Object.assign({ kind: 'advisor' }, data);
      if (kind === 'turn_result') data = Object.assign({ kind: 'result' }, data);
      if (kind === 'jev_fork') data = Object.assign({ kind: 'fork' }, data);
      jev.push(data);
      var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      linesEl.appendChild(renderLines([jevLine(data)]));
      if (atBottom) body.scrollTop = body.scrollHeight;
      refreshJev();
    }

    // ---- rendering -------------------------------------------------------
    function line(ts, cls, glyph, text, detail, entry) { return { ts: ts, cls: cls, glyph: glyph, text: text == null ? '' : String(text), detail: detail, entry: entry }; }

    function entryLines(e) {
      var l = e.line || {}, out = provider === 'codex' ? codexLines(l) : claudeLines(l);
      out.forEach(function (x) { x.entry = e; });
      return out;
    }

    function claudeLines(l) {
      var ts = l.timestamp, out = [];
      if (l.type === 'user' || l.type === 'assistant') {
        var msg = l.message || {}, c = msg.content, isUser = l.type === 'user';
        if (typeof c === 'string') out.push(line(ts, isUser ? 'user' : 'text', isUser ? '❯' : '●', c));
        else (c || []).forEach(function (b) {
          switch (b.type) {
            case 'text': out.push(line(ts, isUser ? 'user' : 'text', isUser ? '❯' : '●', b.text)); break;
            case 'thinking': out.push(line(ts, 'think', '✻', b.thinking ? 'thinking · ' + b.thinking : 'thinking (not shown by the API)', b)); break;
            case 'redacted_thinking': out.push(line(ts, 'think', '✻', 'thinking (redacted)', b)); break;
            case 'tool_use': out.push(line(ts, 'tool', '●', b.name + '(' + compact(b.input) + ')', b.input)); break;
            case 'tool_result': out.push(line(ts, b.is_error ? 'err' : 'result', '⎿', resultText(b.content) || '(no output)', b.content)); break;
            case 'server_tool_use': out.push(line(ts, b.name === 'advisor' ? 'advisor' : 'tool', '◈', b.name === 'advisor' ? 'Advising…' : b.name + '(' + compact(b.input) + ')', b)); break;
            case 'advisor_tool_result': out.push(line(ts, 'advisor', '⎿', advisorResult(b.content), b)); break;
            case 'image': out.push(line(ts, 'meta', '▣', 'image', b)); break;
            default: out.push(line(ts, 'meta', '·', b.type || 'block', b));
          }
        });
        var u = msg.usage;
        if (!isUser && out.length && u) out[out.length - 1].tag = (msg.model || '') + ' · in ' + num(u.input_tokens) + ' · out ' + num(u.output_tokens) + (u.cache_read_input_tokens ? ' · cache ' + num(u.cache_read_input_tokens) : '');
      } else if (l.type === 'system') {
        out.push(line(ts, 'sys', '·', 'system' + (l.subtype ? ' ' + l.subtype : '') + (typeof l.content === 'string' ? ': ' + l.content : ''), l));
      } else if (l.type === 'attachment') {
        out.push(line(ts, 'meta', '·', 'attachment ' + ((l.attachment && l.attachment.type) || ''), l.attachment));
      } else if (l.type === 'queue-operation') {
        out.push(line(ts, 'meta', '·', 'queue ' + (l.operation || '') + (l.content ? ': ' + head(l.content) : ''), l));
      } else {
        out.push(line(ts, 'meta', '·', l.type || 'entry', l));
      }
      return out;
    }

    function codexLines(l) {
      var ts = l.timestamp, p = l.payload || {}, out = [];
      if (l.type === 'response_item') {
        if (p.type === 'message') {
          var role = p.role, text = (p.content || []).map(function (c) { return c.text || c.input_text || ''; }).join('');
          out.push(line(ts, role === 'user' ? 'user' : role === 'assistant' ? 'text' : 'meta', role === 'user' ? '❯' : role === 'assistant' ? '●' : '·', (role !== 'user' && role !== 'assistant' ? role + ': ' : '') + text, p));
        } else if (p.type === 'reasoning') {
          var sum = (p.summary || []).map(function (s) { return s.text || ''; }).join(' ');
          out.push(line(ts, 'think', '✻', sum ? 'reasoning · ' + sum : 'reasoning (encrypted)', p));
        } else if (/_output$/.test(p.type || '')) {
          out.push(line(ts, 'result', '⎿', resultText(p.output) || '(no output)', p.output));
        } else if (/call$/.test(p.type || '')) {
          out.push(line(ts, 'tool', '●', (p.name || p.type) + '(' + compact(p.arguments || p.input || p.action) + ')', p));
        } else out.push(line(ts, 'meta', '·', p.type || 'item', p));
      } else if (l.type === 'event_msg') {
        if (p.type === 'task_started') out.push(line(ts, 'sys', '·', 'turn started', p));
        else if (p.type === 'task_complete') out.push(line(ts, 'sys', '✓', 'turn complete', p));
        else if (p.type === 'error') out.push(line(ts, 'err', '✗', p.message || 'error', p));
        else if (p.type === 'token_count' && p.info && p.info.last_token_usage) { var t = p.info.last_token_usage; out.push(line(ts, 'meta', '·', 'tokens · in ' + num(t.input_tokens) + ' · out ' + num(t.output_tokens) + (t.cached_input_tokens ? ' · cached ' + num(t.cached_input_tokens) : ''), p)); }
        else out.push(line(ts, 'meta', '·', p.type || 'event', p));
      } else if (l.type === 'turn_context') {
        out.push(line(ts, 'sys', '·', 'turn · ' + [p.model, p.effort || p.reasoning_effort].filter(Boolean).join(' · '), p));
      } else out.push(line(ts, 'meta', '·', l.type || 'entry', p));
      return out;
    }

    // A small fork the agent team handed off: SHARP is followed, SPLIT goes
    // back to the main model.
    function forkLine(d) {
      var who = d.backend === 'openai' ? 'decisions' : 'jev';
      var t = who + ' · fork · ' + d.question + ' → ' + (d.choice ? d.choice + ' ' + pct(d.confidence) + ' ' : '') + (d.verdict === 'sharp' ? 'SHARP → follow' : 'SPLIT → main model') +
        (d.error ? ' (' + d.error + ')' : '') + ' · ' + d.latencyMs + ' ms';
      return line(d.at, d.verdict === 'sharp' ? 'jev' : 'jev split', '◇', t, d);
    }

    function jevLine(d) {
      if (d.kind === 'advisor') return advisorLine(d);
      if (d.kind === 'result') return resultLine(d);
      if (d.kind === 'fork') return forkLine(d);
      // Jev and OpenAI Decisions share the store; `backend` says which answered.
      // Decisions has no published price, so its line shows tokens, not dollars.
      var who = d.backend === 'openai' ? 'decisions' : 'jev';
      var spent = d.backend === 'openai' ? (d.inputTokens ? ' · ' + d.inputTokens + ' tok' : '') : ' · $' + (d.costUsd || 0).toFixed(6);
      // A question that was not asked (one model to choose from) is left out.
      var picks = [];
      if (d.pickedModel) picks.push('model ' + d.pickedModel + ' ' + pct(d.modelConfidence));
      if (d.pickedEffort) picks.push('effort ' + d.pickedEffort + ' ' + pct(d.effortConfidence));
      var t = d.error ? who + ' · ' + d.error
        : who + ' · ' + (picks.join(' · ') || 'no answer') + ' → ' + ((d.notes || []).join(', ') || 'no change') + ' · ' + d.latencyMs + ' ms' + spent;
      return line(d.at, d.error ? 'err jev' : 'jev', '◆', t, d);
    }

    // A Claude turn's final result, as `claude -p` prints it: the only place an
    // advisor model's cost shows up.
    function resultLine(r) {
      var per = (r.models || []).map(function (m) { return m.model.replace(/^claude-/, '') + ' $' + (m.costUsd || 0).toFixed(3); }).join(' · ');
      var t = (r.ok ? 'turn done' : 'turn failed') + (r.numTurns ? ' · ' + r.numTurns + ' step' + (r.numTurns === 1 ? '' : 's') : '') + (r.durationMs ? ' · ' + (r.durationMs / 1000).toFixed(1) + ' s' : '') +
        (r.totalCostUsd != null ? ' · $' + r.totalCostUsd.toFixed(3) : '') + (per ? ' (' + per + ')' : '');
      return line(r.at, r.ok ? 'sys' : 'err', r.ok ? '✓' : '✗', t, r);
    }

    // The gateway-built ChatGPT advisor: one line per consultation.
    function advisorLine(a) {
      var what = { plan: 'reviewed the plan', stuck: 'looked at the repeated failure', done: 'reviewed the finished turn' }[a.trigger] || a.trigger;
      var did = { steered: 'steered into the turn', queued: 'queued a follow-up', 'too-late': 'turn had already ended', none: '' }[a.delivered] || '';
      var t = a.error ? 'advisor (' + a.model + ') ' + what + ' · ' + a.error
        : 'advisor (' + a.model + ') ' + what + ' · ' + a.verdict + (a.advice ? ': ' + a.advice : '') + (did ? ' → ' + did : '') +
          ' · ' + Math.round((a.latencyMs || 0) / 1000) + ' s' + (a.inputTokens ? ' · in ' + num(a.inputTokens) + ' · out ' + num(a.outputTokens) : '');
      return line(a.at, a.error ? 'err advisor' : 'advisor', '◈', t, a);
    }

    function mergeJev(lines, decisions) {
      if (!decisions.length) return lines;
      var fresh = decisions.filter(function (d) { var k = (d.kind || d.backend || 'jev') + ':' + (d.trigger || d.question || '') + ':' + d.at + ':' + d.sessionId; if (jevShown[k]) return false; jevShown[k] = 1; return true; }).map(jevLine);
      var out = [], j = 0, lastTs = '';
      lines.forEach(function (x) {
        if (x.ts) lastTs = x.ts;
        while (j < fresh.length && lastTs && fresh[j].ts <= lastTs) out.push(fresh[j++]);
        out.push(x);
      });
      while (j < fresh.length) out.push(fresh[j++]);
      return out;
    }

    function renderLines(lines) {
      var frag = document.createDocumentFragment();
      lines.forEach(function (x) {
        var row = document.createElement('div'); row.className = 'tl ' + x.cls; if (x.ts) row.dataset.ts = x.ts;
        var tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = x.ts ? clock(x.ts) : ''; row.appendChild(tt);
        var tg = document.createElement('span'); tg.className = 'tg'; tg.textContent = x.glyph; row.appendChild(tg);
        var tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = x.text; row.appendChild(tx);
        if (x.tag) { var tag = document.createElement('span'); tag.className = 'ttag'; tag.textContent = x.tag; row.appendChild(tag); }
        row.addEventListener('click', function (ev) {
          if (ev.target.closest('.td')) return;
          var open = row.querySelector('.td');
          if (open) { open.remove(); row.classList.remove('expanded'); return; }
          row.classList.add('expanded');
          var pre = document.createElement('pre'); pre.className = 'td';
          pre.textContent = JSON.stringify(x.detail !== undefined ? x.detail : (x.entry && x.entry.line), null, 2);
          if (x.entry && x.entry.truncated) {
            var more = document.createElement('button'); more.type = 'button'; more.className = 'term-full'; more.textContent = 'Load the full entry';
            more.addEventListener('click', function () {
              var c = cur(); more.disabled = true;
              getJson('/api/conversations/raw-entry' + q(c, '&offset=' + x.entry.at)).then(function (full) { pre.textContent = JSON.stringify(full, null, 2); more.remove(); })
                .catch(function (e) { more.textContent = 'Could not load: ' + e.message; });
            });
            row.appendChild(more);
          }
          row.appendChild(pre);
        });
        frag.appendChild(row);
      });
      return frag;
    }

    // ---- helpers ---------------------------------------------------------
    function compact(v) {
      if (v == null) return '';
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return head(v, 160); } }
      if (typeof v !== 'object') return String(v);
      var pick = v.command || v.cmd || v.file_path || v.path || v.pattern || v.url || v.query || v.description || v.prompt;
      if (Array.isArray(pick)) pick = pick.join(' ');
      return head(pick != null ? String(pick) : JSON.stringify(v), 160);
    }
    function resultText(c) {
      if (c == null) return '';
      if (typeof c === 'string') { try { var j = JSON.parse(c); if (j && typeof j.output === 'string') return j.output; } catch (e) {} return c; }
      if (Array.isArray(c)) return c.map(function (b) { return b && (b.text || (b.type === 'image' ? '[image]' : '')) || ''; }).join('\n');
      if (typeof c === 'object' && typeof c.output === 'string') return c.output;
      return JSON.stringify(c);
    }
    function advisorResult(c) {
      var t = c && c.type || '';
      if (t === 'advisor_redacted_result') return 'advisor reviewed · advice encrypted by the API';
      if (/error|unavailable/.test(t)) return 'advisor unavailable' + (c.error_code ? ' (' + c.error_code + ')' : '');
      if (/declin/.test(t)) return 'advisor declined to advise';
      if (c && typeof c.text === 'string') return 'advisor · ' + c.text;
      return 'advisor · ' + (t || 'result');
    }
    function firstTimestamp(entries) { for (var i = 0; i < entries.length; i++) { var t = entries[i].line && entries[i].line.timestamp; if (t) return t; } return ''; }
    function firstShownTs() { var n = linesEl.querySelector('.tl[data-ts]'); return n ? n.dataset.ts : ''; }
    function head(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); n = n || 120; return s.length > n ? s.slice(0, n) + '…' : s; }
    function num(n) { return n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
    function pct(n) { return n == null ? '' : Math.round(n * 100) + '%'; }
    function mb(b) { return b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }
    function clock(ts) { var d = new Date(ts); return isNaN(d) ? '' : d.toTimeString().slice(0, 8); }

    function showDelegate(id, role) { delegate = { id: id, role: role }; if (open) reload(); else show(); }
    var api = { toggle: toggle, show: show, close: close, showDelegate: showDelegate, isOpen: function () { return open; }, conversationChanged: function () { delegate = null; if (open) reload(); }, event: onEvent };
    try { if (localStorage.getItem('x056_terminal') === '1') setTimeout(show, 0); } catch (e) {}
    return api;
  };
})();
