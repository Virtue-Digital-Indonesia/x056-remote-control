/* Markdown formatting for the composer textarea: pure text transforms.
 *
 * Every function takes the textarea's state { value, start, end } and returns
 * the next state { value, start, end }. Nothing here touches the DOM: the panel
 * turns the difference into ONE native insertText edit (so Cmd+Z undoes a
 * formatting action in one step) and dispatches `input`.
 *
 * The box stays plain Markdown source. The only composer-specific detail is
 * its list display: lists show as padded dot bullets ("  • item") and padded
 * numbers ("  1. item"), which the panel serializes back to Markdown on send.
 * Block transforms that move list lines in or out of a quote or a code fence
 * take `opts.toMarkdown` / `opts.toDisplay` to convert between the two, since
 * inside a quote or fence the panel's serializer no longer sees the line.
 */
(function (root) {
  'use strict';

  function state(value, start, end) { return { value: value, start: start, end: end === undefined ? start : end }; }
  function lineStartAt(value, at) { return at ? value.lastIndexOf('\n', at - 1) + 1 : 0; }
  function lineEndAt(value, at) { var i = value.indexOf('\n', at); return i === -1 ? value.length : i; }
  /** The whole lines a selection touches. A selection ending right after a
   *  newline does not include the empty start of the next line. */
  function lineBlock(value, start, end) {
    var from = lineStartAt(value, start);
    var last = end > start && value[end - 1] === '\n' ? end - 1 : end;
    return { from: from, to: lineEndAt(value, last) };
  }
  function fenceLine(line) { return /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line); }
  function inFence(value, at) {
    var fence = null;
    value.slice(0, at).split('\n').forEach(function (line) {
      var m = fenceLine(line); if (!m) return;
      if (!fence) fence = { marker: m[1][0], length: m[1].length };
      else if (m[1][0] === fence.marker && m[1].length >= fence.length && !m[2].trim()) fence = null;
    });
    return !!fence;
  }

  // ---- inline: bold, italic, underline, code --------------------------------
  // A marker made of one repeated character (`*`, `**`, `` ` ``) is matched by
  // the length of the run, so `**bold**` never reads as italic and the other
  // way round: italic owns runs of 1 and 3 (bold+italic), bold runs of 2 and 3.
  function runAt(text, at, ch, dir) { var n = 0; while (text[at + n * dir] === ch) n++; return n; }
  function runOk(marker, n) {
    if (marker === '*') return n === 1 || n === 3;
    if (marker === '**') return n === 2 || n === 3;
    return n === marker.length;
  }
  function plainRun(marker) { return /^(.)\1*$/.test(marker); }
  /** Does `text` begin with `open` (as a whole run) and end with `close`? */
  function wrappedInside(text, open, close) {
    if (text.length < open.length + close.length) return false;
    if (!plainRun(open)) return text.slice(0, open.length) === open && text.slice(-close.length) === close;
    var ch = open[0], lead = runAt(text, 0, ch, 1), tail = runAt(text, text.length - 1, ch, -1);
    return lead < text.length && runOk(open, lead) && runOk(open, tail);
  }
  /** Are `open`/`close` sitting just outside [s, e)? */
  function wrappedOutside(value, s, e, open, close) {
    if (s < open.length || value.slice(s - open.length, s) !== open || value.slice(e, e + close.length) !== close) return false;
    if (!plainRun(open)) return true;
    var ch = open[0];
    return runOk(open, runAt(value, s - 1, ch, -1)) && runOk(open, runAt(value, e, ch, 1));
  }
  function stripRun(text, open, close) { return text.slice(open.length, text.length - close.length); }

  function wrapInline(st, open, close) {
    close = close === undefined ? open : close;
    var v = st.value, start = st.start, end = st.end;
    if (start === end) {
      var at = start;
      // Empty pair under the caret: the second press takes it away again.
      if (v.slice(at - open.length, at) === open && v.slice(at, at + close.length) === close && wrappedOutside(v, at, at, open, close)) {
        return state(v.slice(0, at - open.length) + v.slice(at + close.length), at - open.length);
      }
      // Caret just before a closing marker of an open pair (closers follow text, never a space): step out of it.
      if (at > 0 && !/\s/.test(v[at - 1]) && v.slice(at, at + close.length) === close && (!plainRun(close) || runOk(close, runAt(v, at, close[0], 1)))) {
        var lineHead = v.slice(lineStartAt(v, at), at), idx = lineHead.lastIndexOf(open);
        if (idx !== -1 && idx + open.length < lineHead.length) return state(v, at + close.length);
      }
      return state(v.slice(0, at) + open + close + v.slice(at), at + open.length);
    }
    var sel = v.slice(start, end);
    if (sel.indexOf('\n') !== -1) return wrapLines(st, open, close);
    // Trim: surrounding spaces stay outside the markers.
    var lead = /^\s*/.exec(sel)[0].length, trail = /\s*$/.exec(sel)[0].length;
    if (lead === sel.length) return state(v.slice(0, end) + open + close + v.slice(end), end + open.length);
    var s = start + lead, e = end - trail, inner = v.slice(s, e);
    if (wrappedInside(inner, open, close)) {
      var bare = stripRun(inner, open, close);
      return state(v.slice(0, s) + bare + v.slice(e), s, s + bare.length);
    }
    if (wrappedOutside(v, s, e, open, close)) {
      return state(v.slice(0, s - open.length) + inner + v.slice(e + close.length), s - open.length, e - open.length);
    }
    return state(v.slice(0, s) + open + inner + close + v.slice(e), s + open.length, e + open.length);
  }
  // Inline markers do not span lines in Markdown, so a multi-line selection is
  // wrapped (or unwrapped) line by line, inside any list or quote prefix.
  var LINE_PREFIX = /^(\s*(?:>\s?)*\s*(?:(?:[-+•]|\*(?=\s)|\d{1,9}[.)])\s+)?)/;
  function wrapLines(st, open, close) {
    var v = st.value, b = lineBlock(v, st.start, st.end), lines = v.slice(b.from, b.to).split('\n');
    var parts = lines.map(function (line) {
      var prefix = LINE_PREFIX.exec(line)[0], body = line.slice(prefix.length);
      var lead = /^\s*/.exec(body)[0], rest = body.slice(lead.length), trail = /\s*$/.exec(rest)[0], core = rest.slice(0, rest.length - trail.length);
      return { prefix: prefix + lead, core: core, trail: trail };
    });
    var filled = parts.filter(function (p) { return p.core; });
    if (!filled.length) return st;
    var off = filled.every(function (p) { return wrappedInside(p.core, open, close); });
    var out = parts.map(function (p) {
      if (!p.core) return p.prefix + p.trail;
      var core = off ? stripRun(p.core, open, close) : wrappedInside(p.core, open, close) ? p.core : open + p.core + close;
      return p.prefix + core + p.trail;
    }).join('\n');
    return state(v.slice(0, b.from) + out + v.slice(b.to), b.from, b.from + out.length);
  }

  // ---- block: quote, lists, rule, fence --------------------------------------
  function mapBlock(st, fn) {
    var v = st.value, b = lineBlock(v, st.start, st.end), original = v.slice(b.from, b.to);
    var out = fn(original.split('\n')).join('\n');
    if (out === original) return st;
    var collapsed = st.start === st.end;
    if (collapsed && original.indexOf('\n') === -1) {
      // One line, no selection: keep the caret on the same text.
      var caret = Math.max(b.from, Math.min(b.from + out.length, st.start + out.length - original.length));
      return state(v.slice(0, b.from) + out + v.slice(b.to), caret);
    }
    return state(v.slice(0, b.from) + out + v.slice(b.to), b.from, b.from + out.length);
  }
  var QUOTE = /^ {0,3}> ?/;
  function toggleQuote(st, opts) {
    opts = opts || {};
    var md = opts.toMarkdown || function (s) { return s; }, disp = opts.toDisplay || function (s) { return s; };
    return mapBlock(st, function (lines) {
      var filled = lines.filter(function (l) { return l.trim(); });
      var off = filled.length > 0 && filled.every(function (l) { return QUOTE.test(l); });
      if (off) return disp(lines.map(function (l) { return l.replace(QUOTE, ''); }).join('\n')).split('\n');
      // A quoted line is no longer seen by the composer's list serializer, so
      // padded dot bullets become Markdown before the marker goes on.
      var single = lines.length === 1;
      return md(lines.join('\n')).split('\n').map(function (l) {
        if (QUOTE.test(l)) return l;
        return l.trim() || single ? '> ' + l : '>';
      });
    });
  }

  var LIST = /^([ \t]*)([-+*•]|(\d{1,9})([.)]))(?:[ \t]+|$)/;
  var QUOTES = /^(?: {0,3}> ?)+/;
  /** Toggle a bullet ('bullet') or numbered ('number') list on the lines.
   *  Plain lines take the composer's padded display markers; lines inside a
   *  quote take Markdown ones, which the send-time serializer never rewrites. */
  function toggleList(st, kind) {
    if (inFence(st.value, lineStartAt(st.value, st.start))) return st;
    var isKind = function (m) { return !!m && (kind === 'number' ? !!m[3] : !m[3]); };
    return mapBlock(st, function (lines) {
      var rows = lines.map(function (line) { var q = QUOTES.exec(line), qp = q ? q[0] : ''; var rest = line.slice(qp.length); return { q: qp, rest: rest, m: LIST.exec(rest) }; });
      var filled = rows.filter(function (r) { return r.rest.trim(); });
      var off = filled.length > 0 && filled.every(function (r) { return isKind(r.m); });
      var counters = {};
      return rows.map(function (r) {
        var m = r.m, line = r.rest;
        if (off) {
          if (!m) return r.q + line;
          return r.q + (r.q ? m[1] : m[1].replace(/^ {1,2}/, '')) + line.slice(m[0].length);
        }
        if (!line.trim() && rows.length > 1) return r.q + line;
        var body = m ? line.slice(m[0].length) : line.replace(/^[ \t]*/, ''), indent;
        if (r.q) indent = m ? m[1] : /^[ \t]*/.exec(line)[0];
        // The composer pads base-level items by two spaces; deeper ones keep theirs.
        else indent = m ? (m[1].length >= 2 ? m[1] : '  ' + m[1]) : '  ' + /^[ \t]*/.exec(line)[0];
        var key = r.q + '|' + indent;
        if (kind === 'bullet') return r.q + indent + (r.q ? '- ' : '• ') + body;
        counters[key] = (counters[key] || 0) + 1;
        return r.q + indent + counters[key] + '. ' + body;
      });
    });
  }

  /** `---` on its own line, a blank line before it so the line above is not
   *  read as a setext heading, the caret on the line after it. */
  function insertRule(st) {
    var v = st.value, pos = lineEndAt(v, Math.max(st.start, st.end));
    var before = v.slice(0, pos), after = v.slice(pos);
    var lead = !before || before === '\n' || /\n\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
    // `after` is empty or starts with the line's newline, which the rule's own
    // newline replaces; text right after gets a blank line to land the caret on.
    var rest = after.slice(1), text = lead + '---\n' + (rest && rest.charAt(0) !== '\n' ? '\n' : '');
    return state(before + text + rest, pos + lead.length + 4);
  }

  /** Wrap the selected lines in ``` fences, take the fences away when the
   *  selection is already fenced, or open an empty fence at the caret. */
  function toggleFence(st, opts) {
    opts = opts || {};
    var md = opts.toMarkdown || function (s) { return s; }, disp = opts.toDisplay || function (s) { return s; };
    var v = st.value;
    if (st.start === st.end) {
      var at = st.start, ls = lineStartAt(v, at), le = lineEndAt(v, at), line = v.slice(ls, le);
      if (!line.trim() && ls > 0 && le < v.length) {
        // The caret inside an empty pair (where the first press left it): take the pair away.
        var ps = lineStartAt(v, ls - 1), ne = lineEndAt(v, le + 1);
        var open = fenceLine(v.slice(ps, ls - 1)), close = fenceLine(v.slice(le + 1, ne));
        if (open && close && !close[2].trim()) return state(v.slice(0, ps) + v.slice(ne), ps);
      }
      if (!line.trim()) return state(v.slice(0, ls) + '```\n\n```' + v.slice(le), ls + 4);
      // Text on the line: open the fence on a line of its own after it.
      return state(v.slice(0, le) + '\n```\n\n```' + v.slice(le), le + 5);
    }
    var b = lineBlock(v, st.start, st.end), lines = v.slice(b.from, b.to).split('\n');
    var first = fenceLine(lines[0]), last = lines.length > 1 && fenceLine(lines[lines.length - 1]);
    if (first && last && !last[2].trim()) {
      var inner = disp(lines.slice(1, -1).join('\n'));
      return state(v.slice(0, b.from) + inner + v.slice(b.to), b.from, b.from + inner.length);
    }
    // Fences sitting just outside the selected lines.
    var prevStart = b.from > 0 ? lineStartAt(v, b.from - 1) : -1, nextEnd2 = b.to < v.length ? lineEndAt(v, b.to + 1) : -1;
    var prev = prevStart >= 0 ? fenceLine(v.slice(prevStart, b.from - 1)) : null, next = nextEnd2 >= 0 ? fenceLine(v.slice(b.to + 1, nextEnd2)) : null;
    if (prev && next && !next[2].trim()) {
      var body = disp(v.slice(b.from, b.to));
      return state(v.slice(0, prevStart) + body + v.slice(nextEnd2), prevStart, prevStart + body.length);
    }
    var code = md(v.slice(b.from, b.to));
    return state(v.slice(0, b.from) + '```\n' + code + '\n```' + v.slice(b.to), b.from + 4, b.from + 4 + code.length);
  }

  // ---- shortcuts --------------------------------------------------------------
  // One table drives the keydown handler, the cheat sheet and the help dialog.
  // `code` is KeyboardEvent.code (physical key): shifted digits report symbols
  // in `key`, and Option on a Mac turns letters into other characters.
  var SHORTCUTS = [
    { id: 'bold', label: 'Bold', sample: '**text**', code: 'KeyB', shift: false },
    { id: 'italic', label: 'Italic', sample: '*text*', code: 'KeyI', shift: false },
    { id: 'underline', label: 'Underline', sample: '<u>text</u>', code: 'KeyU', shift: false },
    { id: 'code', label: 'Inline code', sample: '`text`', code: 'KeyC', shift: true },
    { id: 'fence', label: 'Code block', sample: '```', code: 'KeyX', shift: true },
    { id: 'quote', label: 'Quote', sample: '> text', code: 'Digit9', shift: true },
    { id: 'rule', label: 'Horizontal rule', sample: '---', code: 'Minus', shift: true },
    { id: 'bullet', label: 'Bulleted list', sample: '• item', code: 'Digit8', shift: true },
    { id: 'number', label: 'Numbered list', sample: '1. item', code: 'Digit7', shift: true },
  ];
  var LETTER = { KeyB: 'b', KeyI: 'i', KeyU: 'u', KeyC: 'c', KeyX: 'x' };
  /** Which shortcut a keydown is, or null. Mac takes Cmd (not Ctrl, which is
   *  the Emacs line-editing set there); elsewhere Ctrl. Alt is never part of
   *  one, so AltGr (Ctrl+Alt on Windows) keeps typing its characters. */
  function shortcutFor(e, isMac) {
    if (!e || e.altKey || e.isComposing || e.keyCode === 229) return null;
    if (isMac ? !(e.metaKey && !e.ctrlKey) : !(e.ctrlKey && !e.metaKey)) return null;
    var key = String(e.key || '').toLowerCase();
    for (var i = 0; i < SHORTCUTS.length; i++) {
      var s = SHORTCUTS[i];
      if (!!e.shiftKey !== s.shift) continue;
      var letter = LETTER[s.code];
      // A letter goes by the character typed (AZERTY, Dvorak), falling back to
      // the physical key when the layout types a non-Latin letter there.
      if (letter ? (key === letter || (!/^[a-z]$/.test(key) && e.code === s.code)) : e.code === s.code) return s;
    }
    return null;
  }
  function keysFor(s, isMac) {
    var parts = isMac ? ['⌘'] : ['Ctrl'];
    if (s.shift) parts.push(isMac ? '⇧' : 'Shift');
    var k = s.code === 'Minus' ? '-' : s.code.replace(/^Key|^Digit/, '');
    parts.push(k);
    return isMac ? parts.join('') : parts.join('+');
  }

  function apply(id, st, opts) {
    switch (id) {
      case 'bold': return wrapInline(st, '**');
      case 'italic': return wrapInline(st, '*');
      case 'underline': return wrapInline(st, '<u>', '</u>');
      case 'code': return wrapInline(st, '`');
      case 'fence': return toggleFence(st, opts);
      case 'quote': return toggleQuote(st, opts);
      case 'rule': return insertRule(st);
      case 'bullet': return toggleList(st, 'bullet');
      case 'number': return toggleList(st, 'number');
    }
    return st;
  }
  /** The smallest single replacement turning `a` into `b`. */
  function diff(a, b) {
    var p = 0, max = Math.min(a.length, b.length);
    while (p < max && a[p] === b[p]) p++;
    var s = 0;
    while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { from: p, to: a.length - s, text: b.slice(p, b.length - s) };
  }

  // ---- live highlight -----------------------------------------------------------
  // The composer paints a mirror of the textarea behind it (the textarea's own
  // text is transparent). `highlight` turns the source into runs whose texts
  // join back to EXACTLY the input: every marker stays in place, only classed,
  // so the mirror's characters sit where the textarea's caret expects them.
  // Line by line; fences follow the same rule as `inFence`. Inline parsing is
  // skipped on a line longer than HL_INLINE_MAX (an unmatched opener scans to
  // the end of its line, so a huge line could go quadratic).
  var HL_INLINE_MAX = 2000;
  var HL_RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var HL_HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
  function isSpace(c) { return c === undefined || c === ' ' || c === '\t' || c === '\n'; }
  function isWord(c) {
    if (c === undefined) return false;
    var k = c.charCodeAt(0);
    return (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122);
  }
  var HL_SPECIAL = /[`<*_~]/g;
  /** One array of runs per source line (newlines dropped), so the panel can
   *  re-render only the lines that changed. */
  function highlightLines(value) {
    var out = [], runs = [];
    function push(text, cls) {
      if (!text) return;
      var last = runs[runs.length - 1];
      if (last && last.cls === cls) last.text += text; else runs.push({ text: text, cls: cls });
    }
    function join(base, cls) { return base ? base + ' ' + cls : cls; }
    /** The next run of exactly `n` × `ch` at or after `from`, closing an
     *  emphasis: not preceded by a space (and for `_`, not followed by a letter). */
    function closer(text, from, ch, n, strict) {
      for (var j = text.indexOf(ch, from); j !== -1; j = text.indexOf(ch, j)) {
        var m = runAt(text, j, ch, 1);
        if (m === n && (!strict || !isSpace(text[j - 1])) && (ch !== '_' || !isWord(text[j + n]))) return j;
        j += m;
      }
      return -1;
    }
    function inline(text, base) {
      if (text.length > HL_INLINE_MAX) { push(text, base); return; }
      // A closer search that failed from position p fails from any later p
      // too (it runs to the end of `text`), so it is never repeated: linear.
      var i = 0, plain = 0, failed = {};
      function flush(to) { if (to > plain) push(text.slice(plain, to), base); }
      while (i < text.length) {
        HL_SPECIAL.lastIndex = i;
        var hit = HL_SPECIAL.exec(text);
        if (!hit) break;
        i = hit.index;
        var ch = text[i], n, j;
        if (ch === '<') {
          if (text.slice(i, i + 3) === '<u>' && (j = text.indexOf('</u>', i + 3)) !== -1) {
            flush(i);
            push('<u>', join(base, 'md-mark'));
            inline(text.slice(i + 3, j), join(base, 'md-u'));
            push('</u>', join(base, 'md-mark'));
            i = plain = j + 4;
          } else i++;
          continue;
        }
        n = runAt(text, i, ch, 1);
        if (ch === '`') {
          j = failed['`' + n] ? -1 : closer(text, i + n, '`', n, false);
          if (j === -1) failed['`' + n] = true;
          if (j !== -1) {
            var code = join(base, 'md-code');
            flush(i);
            push(text.slice(i, i + n), join(code, 'md-mark'));
            push(text.slice(i + n, j), code);
            push(text.slice(j, j + n), join(code, 'md-mark'));
            i = plain = j + n;
            continue;
          }
          i += n; continue;
        }
        // Emphasis: * and _ runs of 1-3, ~~ strike. Opens before a non-space;
        // an underscore never opens inside a word (snake_case stays plain).
        var ok = ch === '~' ? n === 2 : n <= 3;
        if (ok && !isSpace(text[i + n]) && !(ch === '_' && isWord(text[i - 1]))) {
          j = failed[ch + n] ? -1 : closer(text, i + n + 1, ch, n, true);
          if (j === -1) failed[ch + n] = true;
          else {
            var cls = ch === '~' ? 'md-s' : n === 1 ? 'md-i' : n === 2 ? 'md-b' : 'md-b md-i';
            flush(i);
            push(text.slice(i, i + n), join(base, 'md-mark'));
            inline(text.slice(i + n, j), join(base, cls));
            push(text.slice(j, j + n), join(base, 'md-mark'));
            i = plain = j + n;
            continue;
          }
        }
        i += n;
      }
      flush(text.length);
    }
    function body(line, base) {
      var h = HL_HEADING.exec(line);
      if (h) { push(h[0], join(base, 'md-mark')); inline(line.slice(h[0].length), join(base, 'md-h')); return; }
      var l = LIST.exec(line);
      if (l) { push(l[0], join(base, 'md-li')); inline(line.slice(l[0].length), base); return; }
      inline(line, base);
    }
    var fence = null, lines = String(value).split('\n');
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      if (k) { out.push(runs); runs = []; }
      var f = fenceLine(line);
      if (f && !fence) { fence = { marker: f[1][0], length: f[1].length }; push(line, 'md-fence'); continue; }
      if (fence) {
        if (f && f[1][0] === fence.marker && f[1].length >= fence.length && !f[2].trim()) { fence = null; push(line, 'md-fence'); }
        else push(line, 'md-pre');
        continue;
      }
      if (HL_RULE.test(line)) { push(line, 'md-hr'); continue; }
      var q = QUOTES.exec(line);
      if (q) { push(q[0], 'md-mark md-qm'); body(line.slice(q[0].length), 'md-q'); continue; }
      body(line, '');
    }
    out.push(runs);
    return out;
  }
  /** The same runs flat, newlines included: their texts join to `value`. */
  function highlight(value) {
    var lines = highlightLines(value), runs = [];
    for (var k = 0; k < lines.length; k++) {
      if (k) {
        var last = runs[runs.length - 1];
        if (last && !last.cls) last.text += '\n'; else runs.push({ text: '\n', cls: '' });
      }
      for (var r = 0; r < lines[k].length; r++) {
        var run = lines[k][r], prev = runs[runs.length - 1];
        if (prev && prev.cls === run.cls) prev.text += run.text; else runs.push({ text: run.text, cls: run.cls });
      }
    }
    return runs;
  }

  var api = { wrapInline: wrapInline, toggleQuote: toggleQuote, toggleList: toggleList, insertRule: insertRule, toggleFence: toggleFence, apply: apply, diff: diff, shortcutFor: shortcutFor, keysFor: keysFor, highlight: highlight, highlightLines: highlightLines, SHORTCUTS: SHORTCUTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ComposerFormat = api;
})(typeof window !== 'undefined' ? window : this);
