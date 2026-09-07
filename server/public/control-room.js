/* Presentation layer for the existing authenticated conversation engine. */
window.createControlRoom = function (engine) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const ic = name => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const iconButton = (id, name, label) => `<button class="cr-icon" id="${id}" aria-label="${label}" title="${label}">${ic(name)}</button>`;
  const main = document.querySelector('body > main'); main.id = 'conversationSurface';
  const legacyNav = document.querySelector('body > aside'); legacyNav.id = 'projectDrawer';
  const scroll = main.querySelector('.scroll');
  const content = document.createElement('div'); content.className = 'focus-main';
  while (main.firstChild) content.append(main.firstChild);
  main.append(content);
  main.insertAdjacentHTML('afterbegin', `<nav id="focusNav" aria-label="Focus navigation"><button class="cr-logo" id="focusHome" title="Back to Control room">x0</button>${iconButton('focusBack','left','Back to Control room')}${iconButton('focusSearch','search','Search conversations')}${iconButton('focusNew','compose','New conversation')}<span class="sp"></span>${iconButton('focusAccounts','user','Accounts')}${iconButton('focusSettings','gear','Display settings')}</nav>`);
  // The existing toolbar actions remain wired; less-used actions live in More.
  main.querySelector('.topbar').insertAdjacentHTML('beforeend', `${iconButton('chatDisplay','gear','Display settings')}${iconButton('chatTheme','moon','Change theme')}${iconButton('chatMax','expand','Maximize conversation')}${iconButton('chatClose','x','Close conversation')}`);
  const shell = document.createElement('section'); shell.id = 'controlRoom'; shell.setAttribute('aria-label', 'Control room');
  shell.innerHTML = `<header class="cr-top"><button class="cr-logo" id="crHome">x0<span>x056</span></button><nav aria-label="Main navigation"><button id="crBoardTab" aria-current="page">Control room</button><button id="crAccountsTab">Accounts</button></nav><span class="sp"></span><span id="crConnection" class="cr-connection">Connecting</span>${iconButton('crProjects','folder','Projects')}${iconButton('crTheme','moon','Change theme')}${iconButton('crSettings','gear','Display settings')}${iconButton('crMore','more','More controls')}</header>
  <div id="crBoard" class="cr-page"><div class="cr-heading"><div><div class="cr-eyebrow">YOUR WORKSPACE</div><h1>Control room</h1><p>Keep an eye on the work. Step in where you’re needed.</p></div><button class="cr-primary" id="crNew">${ic('plus')} New conversation</button></div><div id="crStats" class="cr-stats"></div><div class="cr-tools"><div class="cr-tabs" role="group" aria-label="Conversation filter"><button data-filter="all" class="selected">All conversations</button><button data-filter="unread">Unread</button><button data-filter="active">Active</button></div><label class="cr-search">${ic('search')}<input id="crSearch" type="search" placeholder="Search conversations…" aria-label="Search conversations" /></label><select id="crProjectFilter" aria-label="Filter by project"><option value="">All projects</option></select></div><div id="crBoardError" role="status"></div><div class="cr-board" id="crLanes"></div></div>
  <div id="crAccounts" class="cr-page" hidden></div><div id="crToast" role="status" hidden></div>`;
  document.body.prepend(shell);
  const veil = document.createElement('div'); veil.id = 'chatVeil'; veil.hidden = true; document.body.append(veil);
  const preferences = document.createElement('dialog'); preferences.id = 'displayPreferences'; preferences.className = 'cr-dialog';
  preferences.innerHTML = `<form method="dialog"><header><h2>Make yourself at home</h2><button class="cr-icon" aria-label="Close settings" value="close">${ic('x')}</button></header><p>Choose how conversations open on this device.</p><fieldset><legend>Open conversations in</legend><div class="cr-options"><label><input type="radio" name="open" value="side"><span>${ic('menu')}<strong>Side panel</strong><small>Keep the Control room in view</small></span></label><label><input type="radio" name="open" value="max"><span>${ic('expand')}<strong>Maximized</strong><small>Give the conversation more space</small></span></label></div></fieldset><fieldset><legend>When maximized</legend><div class="cr-options"><label><input type="radio" name="maximize" value="page"><span>${ic('expand')}<strong>Full page</strong><small>Fill the app with Focus mode</small></span></label><label><input type="radio" name="maximize" value="modal"><span>${ic('snippet')}<strong>Large modal</strong><small>A centered chat without a sidebar</small></span></label></div></fieldset><footer><small>Saved automatically on this device.</small><button class="cr-primary">Done</button></footer></form>`;
  document.body.append(preferences);
  let prefs = { open: 'side', maximize: 'page' };
  try { const saved = JSON.parse(localStorage.getItem('x056_display_preferences') || localStorage.getItem('x056_draft_chat_preferences_v1') || '{}'); if (['side','max','maximized'].includes(saved.open)) prefs.open = saved.open === 'maximized' ? 'max' : saved.open; if (['page','modal'].includes(saved.maximize)) prefs.maximize = saved.maximize; } catch {}
  const sectionScroll = {board:0,accounts:0};
  let mode = 'closed', section = 'board', boardFilter = 'all', renderTimer, accountTimer, returnFocus;
  let boardSignature = '', accountSignature = '', analytics = null, routing = null, analyticsError = '', requestVersion = 0;
  const outcomes = new Map();
  const positions = new Map();
  const compact = n => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const totalTokens = r => r.input + r.output + r.cached + r.cacheWrite;
  function toast(message) { $('crToast').textContent = message; $('crToast').hidden = false; clearTimeout(accountTimer); accountTimer = setTimeout(() => $('crToast').hidden = true, 6000); }
  function key() { const s = engine.state(); return s.projectId + '::' + (s.sessionId || ''); }
  function rememberPosition() {
    if (mode === 'closed') return;
    const edge = scroll.getBoundingClientRect().top;
    const nodes = [...$('chat').children];
    const node = nodes.find(n => n.getBoundingClientRect().bottom > edge);
    positions.set(key(), { top:scroll.scrollTop, bottom:scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100, node, signature:node?.textContent, offset:node ? node.getBoundingClientRect().top-edge : 0 });
  }
  function restorePosition() {
    const p = positions.get(key());
    if (!p || p.bottom) { scroll.scrollTop = scroll.scrollHeight; return; }
    const node = p.node?.isConnected ? p.node : [...$('chat').children].find(n=>n.textContent===p.signature);
    scroll.scrollTop = node ? scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - p.offset : p.top;
  }
  function setMode(next) {
    rememberPosition(); mode = next;
    document.body.dataset.chatMode = mode;
    main.hidden = mode === 'closed';
    veil.hidden = mode !== 'modal';
    shell.inert = mode === 'modal' || mode === 'page';
    main.setAttribute('role', mode === 'modal' ? 'dialog' : 'region');
    main.setAttribute('aria-label', 'Conversation');
    if (mode === 'modal') main.setAttribute('aria-modal','true'); else main.removeAttribute('aria-modal');
    $('chatMax').title = $('chatMax').ariaLabel = mode === 'side' ? 'Maximize conversation' : 'Restore side panel';
    if (mode !== 'closed') restorePosition();
  }
  function open() { if (mode === 'closed') { returnFocus = document.activeElement; setMode(prefs.open === 'side' ? 'side' : prefs.maximize); requestAnimationFrame(() => $('chatClose').focus()); } updateTitle(); }
  function close() { engine.closePops(); engine.nav(false); setMode('closed'); if (returnFocus?.isConnected) returnFocus.focus(); else $('crBoardTab').focus(); }
  function showSection(next) { sectionScroll[section] = shell.scrollTop; close(); engine.nav(false); section = next; $('crBoard').hidden = next !== 'board'; $('crAccounts').hidden = next !== 'accounts'; ['Board','Accounts'].forEach(x => $('cr' + x + 'Tab').setAttribute('aria-current', next === x.toLowerCase() ? 'page' : 'false')); if (next === 'accounts') { renderAccountsPage(); loadAnalytics(); engine.pollAccounts(); } else refresh(); shell.scrollTop = sectionScroll[next]; }
  function settings() { engine.closePops(); for (const name of ['open','maximize']) preferences.querySelector(`input[name="${name}"][value="${prefs[name]}"]`).checked = true; preferences.showModal(); }
  preferences.addEventListener('change', e => { if (!['open','maximize'].includes(e.target.name)) return; prefs[e.target.name] = e.target.value; try { localStorage.setItem('x056_display_preferences', JSON.stringify(prefs)); } catch { toast('This browser could not save display settings.'); } if (['page','modal'].includes(mode)) setMode(prefs.maximize); });
  const on = (id, fn) => $(id).addEventListener('click', fn);
  ['crSettings','chatDisplay','focusSettings'].forEach(id => on(id, settings));
  ['crTheme','chatTheme'].forEach(id => on(id, () => $('themeBtn').click()));
  ['crAccountsTab','focusAccounts'].forEach(id => on(id, () => showSection('accounts')));
  ['crHome','crBoardTab','focusHome','focusBack'].forEach(id => on(id, () => showSection('board')));
  on('crProjects', () => engine.nav(!document.body.classList.contains('nav-open')));
  on('crMore', () => $('moreBtn').click()); on('focusSearch', () => $('searchChatsBtn').click());
  ['crNew','focusNew'].forEach(id => on(id, () => { engine.newConversation(); open(); }));
  on('chatClose', close); on('chatMax', () => setMode(mode === 'side' ? prefs.maximize : 'side'));
  veil.addEventListener('click', close);
  $('acctChip').addEventListener('click', e => { e.stopImmediatePropagation(); engine.closePops(); showSection('accounts'); }, true);
  $('crSearch').addEventListener('input', () => renderBoard());
  $('crProjectFilter').addEventListener('change', () => renderBoard());
  shell.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { boardFilter = b.dataset.filter; shell.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('selected', x === b)); renderBoard(); }));
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || document.querySelector('dialog[open],.ui-veil,.palette-veil') || !document.querySelector('#backdrop').hidden || document.body.classList.contains('nav-open')) return;
    if (e.key === 'Escape' && mode !== 'closed') { e.preventDefault(); close(); }
    if (e.key === 'Tab' && mode === 'modal') { const nodes = [...main.querySelectorAll('button,input,textarea,select,[tabindex="0"],a[href]')].filter(n => n.offsetParent && !n.disabled && !n.hidden); const first = nodes[0], last = nodes[nodes.length-1]; if (e.shiftKey && (document.activeElement === first || !main.contains(document.activeElement))) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  });
  function updateTitle() { const s = engine.state(), p = s.projects.find(p => p.id === s.projectId), c = p?.conversations?.find(c => c.sessionId === s.sessionId); main.setAttribute('aria-label', c?.title || 'New conversation'); if (c) $('projTitle').textContent = c.title; }
  function cards() {
    const s = engine.state(), out = [];
    for (const p of s.projects) for (const c of p.conversations || []) {
      const k = p.id + '::' + c.sessionId, q = s.questions[c.sessionId], result = outcomes.get(k) || (c.lastOutcome && { ...c.lastOutcome, ts:c.lastOutcome.at });
      const running = !!s.running[p.id]?.[c.sessionId], bg = !running && !!s.background[p.id]?.[c.sessionId];
      const notification = s.notifications[k];
      const status = q ? 'question' : running ? 'running' : bg ? 'background' : result?.status === 'failed' || !result && notification === 'failed' ? 'failed' : result?.status === 'parked' ? 'parked' : result?.status === 'completed' || notification === 'done' ? 'finished' : 'idle';
      out.push({ p, c, k, status, unread: !!notification, label: q?.question || (running || bg ? s.views[k]?.label : result?.reason) || '', time: result?.ts || c.createdAt });
    }
    return out.sort((a,b) => (Number(new Date(b.time)) || 0) - (Number(new Date(a.time)) || 0));
  }
  const statusLabels = { question:'Needs input', running:'Running', background:'Background work', failed:'Failed', parked:'Parked', finished:'Finished', idle:'Idle' };
  function renderBoard() {
    const all = cards(), state = engine.state();
    const groups = [all.filter(x => ['running','background'].includes(x.status)), all.filter(x => ['question','failed','parked'].includes(x.status)), all.filter(x => ['finished','idle'].includes(x.status))];
    $('crStats').innerHTML = [[groups[0].length,'In progress','Active turns and background work'],[groups[1].length,'Needs attention','Questions, failures, and parked turns'],[all.filter(x=>x.unread).length,'Unread','Conversations with unseen updates'],[state.projects.length,'Projects','Connected workspaces']].map(([n,t,sub]) => `<div><span>${t}</span><strong>${n}</strong><small>${sub}</small></div>`).join('');
    const selector = $('crProjectFilter'), current = selector.value;
    const options = '<option value="">All projects</option>' + state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if (selector.innerHTML !== options) { selector.innerHTML = options; selector.value = current; }
    const query = $('crSearch').value.toLowerCase();
    const displayed = groups.map(group => group.filter(x => (!selector.value || x.p.id === selector.value) && (!query || (x.c.title + ' ' + x.p.name + ' ' + x.label).toLowerCase().includes(query)) && (boardFilter === 'all' || boardFilter === 'unread' && x.unread || boardFilter === 'active' && ['running','background'].includes(x.status))));
    const html = displayed.map((group,i) => `<section class="cr-lane"><header><span class="cr-lane-dot dot-${i}"></span><h2>${['In progress','Needs attention','Finished & idle'][i]}</h2><span>${group.length}</span></header><div class="cr-lane-cards">${group.length ? group.map(x => `<button class="cr-task" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}"><div class="cr-task-top"><span>${esc(x.p.name)}</span>${x.unread ? '<span class="cr-unread" title="Unread update">Unread</span>' : ic('more')}</div><h3>${esc(x.c.title || 'Conversation')}</h3><p>${esc(x.label || (x.status === 'finished' ? 'Latest turn completed. Open the conversation to continue.' : x.status === 'idle' ? 'Ready when you are.' : 'Working on your request…'))}</p><footer><span class="cr-status ${x.status}"><i></i>${statusLabels[x.status]}</span><span>${x.c.provider === 'codex' ? 'ChatGPT' : 'Claude'}</span></footer></button>`).join('') : `<div class="cr-empty">${['No active work','Nothing needs attention','No conversations here'][i]}</div>`}</div></section>`).join('');
    if (html !== boardSignature) { boardSignature = html; const focused = document.activeElement?.closest('.cr-task')?.dataset.session; $('crLanes').innerHTML = html; if (focused) [...$('crLanes').querySelectorAll('.cr-task')].find(n=>n.dataset.session===focused)?.focus({preventScroll:true}); $('crLanes').querySelectorAll('[data-session]').forEach(b => b.addEventListener('click', async () => { b.disabled = true; try { rememberPosition(); await engine.select(b.dataset.project, b.dataset.session); engine.markRead(); open(); restorePosition(); } catch (e) { toast(e.message); } finally { b.disabled = false; } })); }
    updateTitle();
  }
  function refresh() { clearTimeout(renderTimer); renderTimer = setTimeout(() => { renderBoard(); if (section === 'accounts') renderAccountRows(); }, 60); }
  async function json(url, body) { const res = await engine.api(url, body === undefined ? undefined : { method:'POST', body:JSON.stringify(body) }); const data = await res.json(); if (!res.ok) throw new Error(data.message || 'Request failed'); return data; }
  function event(kind, data) {
    if (['session_done','session_error','turn_orphaned'].includes(kind)) outcomes.set(data.projectId + '::' + data.sessionId, { status:kind === 'session_done' ? data.status : 'failed', reason:data.reason || data.message, ts:data.ts || Date.now() });
    if (kind === 'session_started') outcomes.delete(data.projectId + '::' + data.sessionId);
    refresh();
    if (section === 'accounts' && ['session_done','accounts'].includes(kind)) loadAnalytics();
  }
  function renderAccountsPage() {
    if ($('accountProvider')) return;
    $('crAccounts').innerHTML = `<div class="cr-heading"><div><div class="cr-eyebrow">ACCOUNTS & USAGE</div><h1>Your accounts</h1><p>Availability now. A clearer view of usage over time.</p></div><div class="cr-actions"><button class="cr-secondary" id="accountExport">${ic('down')} Export CSV</button><button class="cr-primary" id="accountAdd">${ic('plus')} Add account</button></div></div><div class="cr-tools"><select id="accountProvider" aria-label="Provider"><option value="">All providers</option><option value="codex">ChatGPT</option><option value="claude">Claude</option></select><span class="sp"></span><select id="accountDays" aria-label="Usage date range"><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select><button class="cr-secondary" id="accountRefresh">${ic('repeat')} Refresh</button></div><div id="accountStatus" role="status" class="cr-note"></div><div id="accountStats" class="cr-stats"></div><div class="cr-charts"><section class="cr-chart-card"><header><h2>Daily activity</h2><span>Attempts · UTC</span></header><div id="accountChart" class="cr-chart"></div><div id="accountChartCaption" class="cr-chart-caption">Select a day to inspect activity.</div></section><section class="cr-chart-card"><header><h2>Tokens by model</h2><span>Reported usage</span></header><div id="accountModels"></div></section></div><div class="cr-section-head"><h2>Connected accounts</h2><span>Live availability and provider limits</span></div><div id="accountRows"></div><div id="accountRouting"></div><p id="accountCoverage" class="cr-note"></p>`;
    on('accountAdd', () => $('addAcctBtn').click()); on('accountExport', exportCsv);
    on('accountRefresh', () => { engine.pollAccounts(); loadAnalytics(); });
    $('accountProvider').addEventListener('change', () => { renderAccountRows(); loadAnalytics(); });
    $('accountDays').addEventListener('change', loadAnalytics);
    renderAccountRows();
  }
  async function loadAnalytics() {
    if (!$('accountDays')) return;
    const version = ++requestVersion, provider = $('accountProvider').value;
    analytics = null; analyticsError = ''; renderAnalytics();
    $('accountStatus').textContent = 'Updating usage…'; $('accountExport').disabled = true;
    try {
      const [data, policy] = await Promise.all([json('/api/accounts/analytics?days=' + $('accountDays').value + (provider ? '&provider=' + provider : '')), json('/api/accounts/routing')]);
      if (version !== requestVersion) return;
      analytics = data; routing = policy; analyticsError = ''; renderAnalytics(); renderAccountRows();
    } catch (e) { if (version !== requestVersion) return; analytics = null; analyticsError = e.message; renderAnalytics(); }
  }
  function selectedAccounts() { const p = $('accountProvider')?.value; return engine.state().accounts.filter(a => !p || a.provider === p); }
  function available(a) { return !a.paused && !['limited','unauthenticated'].includes(a.state?.kind); }
  function renderAnalytics() {
    const accounts = selectedAccounts(), rows = analytics?.rows || [];
    const attempts = rows.reduce((n,r) => n+r.attempts,0), completed = rows.reduce((n,r) => n+r.completed,0), reported = rows.reduce((n,r)=>n+r.reported,0), tokens = rows.reduce((n,r)=>n+totalTokens(r),0);
    $('accountStatus').textContent = analyticsError ? 'Usage could not be loaded: ' + analyticsError : '';
    $('accountStats').innerHTML = [[`${accounts.filter(available).length} / ${accounts.length}`,'Available accounts','Current routing pool'],[analytics ? compact(attempts) : '—','Attempts','Includes retries and account switches'],[reported ? compact(tokens) : '—','Reported tokens',reported ? `${reported} attempts with token reports` : 'No token reports in this period'],[attempts ? Math.round(completed/attempts*100) + '%' : '—','Completed','Share of recorded attempts']].map(([n,t,sub])=>`<div><span>${t}</span><strong>${n}</strong><small>${sub}</small></div>`).join('');
    const daily = (analytics?.dates || []).map(date => ({ date, codex: rows.filter(r=>r.date===date&&r.provider==='codex').reduce((n,r)=>n+r.attempts,0), claude: rows.filter(r=>r.date===date&&r.provider==='claude').reduce((n,r)=>n+r.attempts,0) }));
    const max = Math.max(1,...daily.map(d=>d.codex+d.claude));
    $('accountChart').innerHTML = daily.length ? daily.map((d,i)=>`<button class="cr-day" data-day="${i}" aria-label="${d.date}: ${d.codex+d.claude} attempts"><span class="cr-bar-stack" style="height:${(d.codex+d.claude)/max*100}%"><i class="codex" style="flex:${d.codex}"></i><i class="claude" style="flex:${d.claude}"></i></span><small>${daily.length===7 || i%5===0 ? d.date.slice(8) : ''}</small></button>`).join('') : '<p class="cr-note">Usage unavailable</p>';
    $('accountChart').querySelectorAll('[data-day]').forEach(b => b.onclick = () => { const d = daily[Number(b.dataset.day)]; $('accountChartCaption').textContent = `${d.date} · ChatGPT ${d.codex} · Claude ${d.claude} attempts`; });
    const models = new Map(); rows.forEach(r=>models.set(r.model,(models.get(r.model)||0)+totalTokens(r)));
    $('accountModels').innerHTML = [...models].sort((a,b)=>b[1]-a[1]).filter(x=>x[1]>0).map(([m,n])=>`<div class="cr-model"><div><span>${esc(m)}</span><strong>${compact(n)}</strong></div><div class="cr-track"><i style="width:${tokens ? n/tokens*100 : 0}%"></i></div></div>`).join('') || '<p class="cr-empty">No reported tokens in this period.</p>';
    $('accountCoverage').textContent = analytics ? `Collection began ${new Date(analytics.since).toLocaleString()}. ${analytics.scope}` : 'Historical usage is unavailable. Current account limits remain visible.';
    $('accountExport').disabled = !analytics;
    renderRouting();
  }
  function quota(a) {
    const q = a.quota;
    const windows = q?.windows?.length ? q.windows : q ? [{...q.fiveHour,label:'5-hour'}, {...q.sevenDay,label:'7-day'}, ...(q.weeklyScoped||[])].filter(w=>typeof w.utilization==='number') : [];
    if (!windows.length) return `<div class="cr-note">${a.quotaError ? 'Usage temporarily unavailable' : 'No usage windows reported'}</div>`;
    return windows.map(w => { const p = Math.max(0,Math.min(100,Math.round(w.utilization*(a.provider === 'codex' ? 100 : 1)))); const raw = w.resetsAt, date = typeof raw==='number' ? new Date(raw*1000) : raw ? new Date(raw) : null; return `<div class="cr-quota"><div><span>${esc(w.label)}</span><strong>${p}%</strong></div><div class="cr-track ${p>=90?'high':''}"><i style="width:${p}%"></i></div><small>${date && !isNaN(date) ? 'Resets ' + esc(date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})) : 'Reset time unavailable'}</small></div>`; }).join('') + (a.quotaStale ? `<small class="cr-stale">Cached reading${a.quotaAt ? ' · '+esc(new Date(a.quotaAt).toLocaleTimeString()) : ''}</small>` : '');
  }
  function renderAccountRows() {
    if (!$('accountRows')) return;
    const list = selectedAccounts();
    const html = `<div class="cr-account-table"><div class="cr-account-head"><span>Account</span><span>Status</span><span>Usage windows</span><span>Routing</span></div>${list.map(a => { const status = a.paused?'Paused':a.state?.kind==='limited'?'Limited':a.state?.kind==='unauthenticated'?'Needs login':a.state?.kind==='ok'?'Available':'Not checked'; return `<article class="cr-account-row"><div class="cr-identity"><span class="cr-account-avatar">${a.provider==='codex'?'G':'C'}</span><div><strong>${esc(a.displayName || a.name)}</strong><small>${esc(a.email || a.name)}</small><small>${a.provider==='codex'?'ChatGPT':'Claude'} · ${esc(a.name)}</small></div></div><div><span class="cr-account-state ${a.paused?'paused':a.state?.kind==='limited'?'limited':''}">${esc(status)}</span>${a.state?.kind==='limited'&&!a.state.estimated?`<small class="cr-note">Resets ${esc(new Date(a.state.until*1000).toLocaleString())}</small>`:''}</div><div class="cr-quotas">${quota(a)}</div><div class="cr-account-actions"><button class="cr-secondary" data-next="${esc(a.name)}" ${!available(a)||a.nextUp?'disabled':''}>${a.nextUp?'Next up':'Use next'}</button><button class="cr-secondary" data-manage="${esc(a.name)}">Manage</button></div></article>`; }).join('') || '<div class="cr-empty">No accounts connected. Add an account to get started.</div>'}</div>`;
    if (html !== accountSignature) {
      accountSignature = html; $('accountRows').innerHTML = html;
      $('accountRows').querySelectorAll('[data-next]').forEach(b=>b.onclick=()=>mutate(b,'/api/accounts/active',{name:b.dataset.next},'Next account updated.'));
      $('accountRows').querySelectorAll('[data-manage]').forEach(b=>b.onclick=()=>accountDetail(list.find(a=>a.name===b.dataset.manage)));
    }
    renderAnalytics();
  }
  async function mutate(button, url, body, message) { button.disabled = true; try { await json(url,body); await engine.pollAccounts(); if(section==='accounts') await loadAnalytics(); toast(message); } catch(e) { toast(e.message); } finally { if(button.isConnected) button.disabled=false; } }
  function renderRouting() {
    if (!$('accountRouting')) return;
    const providers = [...new Set(selectedAccounts().map(a=>a.provider))];
    $('accountRouting').innerHTML = routing ? providers.map(p=>`<label class="cr-routing"><span><strong>Automatic switching · ${p==='codex'?'ChatGPT':'Claude'}</strong><small>Continue on another available account when a limit or login failure stops a turn.</small></span><input type="checkbox" data-routing="${esc(p)}" ${routing.autoSwitch[p]?'checked':''} aria-label="Automatic switching for ${p==='codex'?'ChatGPT':'Claude'}"></label>`).join('') : '';
    $('accountRouting').querySelectorAll('[data-routing]').forEach(input=>input.onchange=async()=>{ const enabled=input.checked; input.disabled=true; try { routing=await json('/api/accounts/routing',{provider:input.dataset.routing,enabled}); renderRouting(); toast('Routing preference saved.'); } catch(e) {input.checked=!enabled;input.disabled=false;toast(e.message);} });
  }
  function accountDetail(a) {
    const d = document.createElement('dialog'); d.className = 'cr-dialog'; d.id = 'accountDetail';
    const rows = (analytics?.rows||[]).filter(r=>r.account===a.name);
    d.innerHTML = `<header><h2>${esc(a.displayName||a.name)}</h2><button class="cr-icon" data-close aria-label="Close account details">${ic('x')}</button></header><p>${esc(a.email||a.name)} · ${a.provider==='codex'?'ChatGPT':'Claude'}</p><div class="cr-quotas">${quota(a)}</div><p>${analytics ? rows.reduce((n,r)=>n+r.attempts,0) + ' recorded attempts · ' + compact(rows.reduce((n,r)=>n+totalTokens(r),0)) + ' reported tokens in the selected period.' : 'Usage for this period is unavailable.'}</p><div class="cr-dialog-actions"><button class="cr-secondary" data-pause>${a.paused?'Resume account':'Pause account'}</button><button class="cr-secondary" data-legacy>More account controls</button></div><p class="cr-note">Pausing excludes this account from future attempts. Running conversations continue.</p>`;
    document.body.append(d); d.showModal();
    d.querySelector('[data-close]').onclick=()=>d.close(); d.addEventListener('close',()=>d.remove());
    d.querySelector('[data-pause]').onclick=async e=>{ await mutate(e.target,'/api/accounts/paused',{name:a.name,paused:!a.paused},a.paused?'Account resumed.':'Account paused.'); d.close(); };
    d.querySelector('[data-legacy]').onclick=()=>{d.close();engine.manageAccount(a);};
  }
  function exportCsv() {
    if (!analytics) return;
    const keys=['date','account','provider','model','attempts','completed','failed','interrupted','reported','input','output','cached','cacheWrite'];
    const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
    const csv=[keys.join(','),...analytics.rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); const a=document.createElement('a');a.href=url;a.download='x056-usage-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  new MutationObserver(() => { const connected = !$('dot').classList.contains('off'); $('crConnection').textContent = connected ? 'Connected' : 'Reconnecting'; $('crConnection').classList.toggle('connected',connected); }).observe($('dot'),{attributes:true});
  setMode('closed'); refresh();
  return { error:message=>{ $('crBoardError').textContent=message; }, open, refresh, event, rememberPosition, restorePosition, isOpen:()=>mode!=='closed', beforeSwitch:rememberPosition, afterHistory:restorePosition, showAccounts:()=>showSection('accounts') };
};
