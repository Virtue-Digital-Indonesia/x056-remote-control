/* Free-form Chat uses the existing conversation engine and its delivery ledger. */
window.createRCChat = function (engine, room) {
  'use strict';
  const $ = id => document.getElementById(id), esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let enabled = false, mounted = false, active = '', selectedFile = '', selectedVersion = '', tab = 'files', files = [], sequence = 0, previewTimer, objectURLs = [], showArchived = false, showRemoved = false;
  const jobs = new Map();
  let routing = false, routeQueue = Promise.resolve();
  const chatPath = id => '/chat' + (id ? '/' + encodeURIComponent(id) : '');
  const inChat = () => /^\/chat(?:\/|$)/.test(location.pathname);
  // The Bot (the owner's assistant) is one ordinary Chat; /bot opens it, or sets it up.
  const inBot = () => location.pathname === '/bot';
  // The orb: the Bot's one avatar, pure CSS (rc-chat.css). state: idle | working; `happy` is a class added for ~1.5 s.
  const orb = (px, state = 'idle', label = '') => `<span class="bot-orb" data-state="${state}" style="--s:${px}px;--d:${(Math.random() * 4).toFixed(1)}s"${label ? ` role="img" aria-label="${label}" title="${label}"` : ' aria-hidden="true"'}><i class="bo-body"></i><i class="bo-eyes"><b></b><b></b></i></span>`;
  let bot = null, botRequest = null, briefTimer, leanFrame = 0, leanEvent, doneTimer, briefing = false, overview = null, overviewAt = 0, needsTimer = 0, wasBot = false, todayPop = null;
  // The Bot's display name and attention. Both come from the server (the Bot's /api/projects row `botName` /
  // `botAttention`, GET /api/bot `name` / `attention`, the live `bot_attention` event) and are never guessed here.
  // Every Bot label reads botName (escaped wherever it reaches innerHTML); everything that shows the
  // indicator listens for `x056:bot` or asks botStatus().
  let botName = 'Bot', botAtt = { needsMe: 0, fyi: false };
  const normAtt = a => ({ needsMe: Math.max(0, Math.floor(+a?.needsMe || 0)), fyi: !!a?.fyi });
  const botRow = () => engine.state().projects.find(p => p.bot);
  function botLabel() {
    const n = botAtt.needsMe;
    return n > 0 ? `${botName}: ${n} ${n === 1 ? 'needs' : 'need'} you` : botAtt.fyi ? `${botName}: new message` : '';
  }
  const botStatus = () => ({ name: botName, needsMe: botAtt.needsMe, fyi: botAtt.fyi, label: botLabel() });
  // Take what the server says. Rows are patched too, so a later x056:state does not bring back an older value.
  function applyBot({ name, attention, row } = {}) {
    const r = row || botRow(), before = botName + '|' + botAtt.needsMe + '|' + botAtt.fyi;
    if (typeof name === 'string' && name.trim()) { botName = name.trim(); if (r) r.botName = botName; }
    if (attention && typeof attention === 'object') { botAtt = normAtt(attention); if (r) r.botAttention = { ...botAtt }; }
    if (before === botName + '|' + botAtt.needsMe + '|' + botAtt.fyi) return;
    paintBotNames();
    document.dispatchEvent(new CustomEvent('x056:bot', { detail: botStatus() }));
  }
  // The indicator: FYI is a small dot, Needs me a pill with the count (Needs me wins when both are set).
  // One markup for the sidebar, both top bars and the /chat row; rc-chat.css / workspace.css place it.
  const botBadgeHTML = cls => {
    const n = botAtt.needsMe, label = botLabel(); if (!label) return '';
    return `<span class="bot-ind ${cls}" data-kind="${n > 0 ? 'needs' : 'fyi'}" role="img" aria-label="${esc(label)}">${n > 0 ? (n > 99 ? '99+' : n) : ''}</span>`;
  };
  const syncBotFromRow = () => { const r = botRow(); if (r && (r.botName || r.botAttention)) applyBot({ name: r.botName, attention: r.botAttention ?? (r.botName ? {} : undefined), row: r }); };
  // Small inline glyphs for the Bot's header (the sun is the panel's own #i-sun path).
  const SVG = {
    sun: '<svg class="rb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    check: '<svg class="rb-ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    today: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>'
  };
  // "Brief me now": the Bot's signature action. One look on the header, the hero chip and the quick row (state lives in data-state).
  const briefButton = (id, cls = '') => `<button type="button" class="rc-brief ${cls}"${id ? ` id="${id}"` : ''} aria-label="Brief me now" title="Brief me now" data-state="idle">${SVG.sun}<span class="rb-spin" aria-hidden="true"></span>${SVG.check}<span class="rb-label">Brief me now</span></button>`;
  const QUICK = [["What's running right now?", "What's running right now?"], ['Does anything need me?', 'Does anything need me?'], ['Delegate a task…', 'Delegate: ']];
  const chipsHTML = () => QUICK.map(([label, text]) => `<button type="button" class="rc-bot-chip" data-text="${esc(text)}">${esc(label)}</button>`).join('') + briefButton('', 'rc-bot-chip');
  const wireChip = chip => { chip.onmousedown = event => event.preventDefault(); chip.onclick = () => chip.classList.contains('rc-brief') ? briefNow() : engine.insertPrompt(chip.dataset.text); };
  const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ({edit:'<path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5"/>',archive:'<path d="M4 9h16v12H4z M3 3h18v6H3z M9 13h6"/>',controls:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',link:'<path d="m9 15 6-6 M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',chevron:'<path d="m9 5 7 7-7 7"/>',chat:'<path d="M21 11a9 9 0 0 1-9 9H4l-3 2 2-6A9 9 0 1 1 21 11Z"/>'}[name] || '') + '</svg>';
  const current = () => engine.state().projects.find(p => p.id === engine.state().projectId && p.kind === 'chat');
  const request = async (url, body) => { const response = await engine.api(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Request failed'); return data; };
  const base = id => '/api/chats/' + encodeURIComponent(id);
  const versionURL = (file, version) => `${base(active)}/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(version.id)}`;
  function dialog(title, body, className = '') {
    const d = document.createElement('dialog'); d.className = 'cr-dialog rc-chat-dialog ' + className;
    const titleId = 'rcDialog-' + crypto.randomUUID(); d.setAttribute('aria-labelledby', titleId);
    d.innerHTML = `<header><h2 id="${titleId}">${esc(title)}</h2><button class="cr-icon" type="button" aria-label="Close">×</button></header>${body}`;
    d.querySelector('header button').onclick = () => d.close();
    d.addEventListener('click', event => { const r = d.getBoundingClientRect(); if (event.target === d && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) d.close(); });
    d.onclose = () => d.remove(); document.body.append(d); d.showModal(); return d;
  }
  function notify(error) { room.notify(error instanceof Error ? error.message : error); }
  function mount() {
    if (mounted) return; mounted = true;
    const button = document.createElement('a'); button.id = 'crChatTab'; button.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-chat"/></svg><span>Chat</span>'; button.href = '/chat'; button.dataset.chatLink = ''; $('crBoardTab').after(button);
    const nav = document.createElement('aside'); nav.id = 'rcChatNav'; nav.setAttribute('aria-label','Chats');
    nav.innerHTML = `<a class="rc-chat-home" id="rcChatHome" href="/chat" data-chat-link>x0 <span>Chat</span></a><button class="cr-primary" id="rcChatNew">+ New chat</button><input id="rcChatSearch" type="search" placeholder="Search chats" aria-label="Search chats"><div class="rc-chat-list" id="rcChatList"></div><button class="cr-secondary" id="rcChatArchives">Archived chats</button><button class="cr-secondary" id="rcChatAccounts">Accounts</button><a class="cr-secondary" id="rcChatControl" href="/" data-chat-link>Control room</a>`;
    $('conversationSurface').prepend(nav);
    const welcome = document.createElement('section'); welcome.id = 'rcChatWelcome';
    welcome.innerHTML = `<button class="cr-secondary" id="rcChatWelcomeMenu">Chats</button><div class="rc-chat-welcome-copy">${icon('chat')}<h1>What are we working on?</h1><p>Start a conversation, bring your files, and pick up where you left off.</p><button class="cr-primary" id="rcChatWelcomeNew">New chat</button></div>`;
    $('conversationSurface').append(welcome);
    const setup = document.createElement('section'); setup.id = 'rcBotSetup';
    setup.innerHTML = `<span class="bot-aurora" aria-hidden="true"></span><form class="rc-bot-card" id="rcBotSetupForm" aria-labelledby="rcBotSetupTitle" novalidate>${orb(72)}<h1 id="rcBotSetupTitle">Set up your Bot</h1><p>Your Bot is a personal assistant chat. It hands work to the right conversation, follows up on it, and reports back.</p><p>It briefs you every morning, and messages you when something needs you.</p><label class="rc-bot-time">Morning brief<input type="time" name="briefAt" value="07:30" required></label><small class="rc-bot-tz">Asia/Jakarta time</small><p class="rc-bot-error" role="alert"></p><button class="cr-primary" type="submit">Enable Bot</button></form>`;
    $('conversationSurface').append(setup);
    $('rcBotSetupForm').onsubmit = enableBot;
    const hero = document.createElement('section'); hero.id = 'rcBotHero'; hero.setAttribute('aria-label', 'Bot welcome');
    hero.innerHTML = `<span class="bot-aurora" aria-hidden="true"></span>${orb(72)}<h2 id="rcBotGreeting">Hello</h2><p>What can I take off your plate?</p><div class="rc-bot-chips">${chipsHTML()}</div>`;
    $('chat').before(hero);
    hero.querySelectorAll('.rc-bot-chip').forEach(wireChip);
    new MutationObserver(syncBotWork).observe($('busy'), { childList: true });
    new MutationObserver(records => { syncBotSystemHistory(records); syncBotHero(); }).observe($('chat'), { childList: true });
    document.addEventListener('x056-history', () => { syncBotSystemHistory(); syncBotHero(); });
    document.addEventListener('visibilitychange', () => { document.documentElement.classList.toggle('bot-hidden', document.hidden); if (botVisible() && Date.now() - overviewAt > 10000) loadOverview(); });
    if (matchMedia('(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)').matches) document.addEventListener('pointermove', leanEyes, { passive: true });
    const botHead = document.createElement('div'); botHead.id = 'rcBotHead'; botHead.hidden = true;
    botHead.innerHTML = `<div class="rcb-id">${orb(36, 'idle', 'Bot is idle')}<span class="rcb-name"><span class="rc-bot-badge">Bot</span><span class="rcb-sub"><span id="rcBotStatus">Idle</span><span id="rcBotBriefAt"></span></span></span></div><div class="rcb-actions"><button type="button" class="rcb-needs" id="rcBotNeeds" hidden aria-haspopup="dialog"><span class="rn-dot" aria-hidden="true"></span><span class="rn-count"></span><span class="rn-txt"></span></button>${briefButton('rcBotBriefNow')}<span id="rcBotBriefStatus" role="status"></span><button type="button" class="cr-icon" id="rcBotToday" aria-label="Today" title="Today: what needs you, what is running" aria-haspopup="dialog" aria-expanded="false">${SVG.today}</button><button type="button" class="cr-icon" id="rcBotSettings" aria-label="Bot settings" title="Bot settings" aria-haspopup="dialog">${SVG.gear}</button></div>`;
    ($('projTitle')?.closest('.project-heading') || $('projTitle'))?.after(botHead);
    $('rcBotBriefNow').onclick = briefNow; $('rcBotNeeds').onclick = $('rcBotToday').onclick = () => toggleToday(); $('rcBotSettings').onclick = openSettings;
    const quick = document.createElement('div'); quick.id = 'rcBotQuick'; quick.hidden = true; quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', 'Quick actions');
    quick.innerHTML = chipsHTML();
    ($('composerBox') || document.querySelector('.composer-wrap').lastElementChild).before(quick);
    quick.querySelectorAll('.rc-bot-chip').forEach(wireChip);
    // While hidden system rows are shown, say so above the composer, with the way back.
    const pill = document.createElement('div'); pill.id = 'rcBotSystemPill'; pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'Hidden messages');
    pill.innerHTML = '<span>Showing hidden messages</span><span aria-hidden="true">·</span><button type="button" id="rcBotSystemHide">Hide</button>';
    quick.before(pill);
    $('rcBotSystemHide').onclick = () => { setSystemHistory(false); $('rcBotToday')?.focus({ preventScroll: true }); };
    for (const type of ['input', 'focusin', 'focusout']) $('prompt')?.addEventListener(type, syncBotQuick);
    document.addEventListener('click', () => setTimeout(syncBotQuick));
    new MutationObserver(syncBotQuick).observe($('attachRow') || document.body, { childList: true });
    const panel = document.createElement('aside'); panel.id = 'rcChatInspector'; panel.setAttribute('aria-label', 'Chat files and references');
    panel.innerHTML = `<header><strong>Workspace</strong><button class="cr-icon" id="rcChatPanelClose" aria-label="Close file panel">×</button></header><div class="rc-chat-tabs"><button data-chat-tab="files" aria-pressed="true">Files</button><button data-chat-tab="preview">Preview</button><button data-chat-tab="references">References</button></div><div id="rcChatUploads" role="status"></div><div id="rcChatPanelBody"></div>`;
    $('conversationSurface').append(panel);
    const tools = document.createElement('div'); tools.id = 'rcChatControls';
    tools.innerHTML = `<button class="cr-secondary" id="rcChatMenu">Chats</button><span id="rcChatProvider"></span><button class="cr-secondary" id="rcChatTools">Tools</button><button class="cr-secondary" id="rcChatReference">@ Reference</button><button class="cr-secondary" id="rcChatFiles">Files</button><button class="cr-icon" id="rcChatMore" aria-label="Chat actions">•••</button>`;
    document.querySelector('.composer-wrap').prepend(tools);
    const ownerPill = $('rcOwnerPill'); if (ownerPill) document.querySelector('.composer-wrap').prepend(ownerPill);
    $('rcChatNew').onclick = $('rcChatWelcomeNew').onclick = newChat;
    $('rcChatWelcomeMenu').onclick = () => window.rcWorkspace?.ready() ? $('crProjects').click() : document.body.classList.toggle('rc-chat-nav-open');
    $('rcChatAccounts').onclick = () => { leave(); room.showAccounts(); };
    $('rcChatSearch').oninput = renderChats;
    $('rcChatArchives').onclick = () => { showArchived = !showArchived; $('rcChatArchives').textContent = showArchived ? 'Active chats' : 'Archived chats'; renderChats(); };
    $('rcChatMenu').onclick = () => window.rcWorkspace?.ready() ? $('crProjects').click() : document.body.classList.toggle('rc-chat-nav-open');
    $('rcChatFiles').onclick = () => { document.body.classList.add('rc-chat-panel-open'); tab = 'files'; renderPanel(); };
    $('rcChatPanelClose').onclick = () => document.body.classList.remove('rc-chat-panel-open');
    $('rcChatTools').onclick = toolsDialog; $('rcChatReference').onclick = referencePicker; $('rcChatMore').onclick = chatActions;
    panel.querySelectorAll('[data-chat-tab]').forEach(button => button.onclick = () => { tab = button.dataset.chatTab; renderPanel(); });
  }
  function navigate(path, replace = false) {
    if (location.pathname !== path) window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
    return applyRoute();
  }
  function applyRoute() {
    routeQueue = routeQueue.then(async () => {
      routing = true;
      try {
        document.querySelectorAll('.rc-chat-dialog[open]').forEach(d => d.close());
        if (inBot()) {
          let data = null, error = '';
          try { data = await loadBot(); } catch (e) { error = e.message; }
          if (!inBot()) return;
          if (data?.enabled && data.url) window.history.replaceState({}, '', data.url);
          else { showBotSetup(data, error); return; }
        }
        if (!inChat()) { leave(false, !!window.rcProjectSpaces?.handles(location.pathname)); return; }
        const path = location.pathname;
        await engine.reloadProjects();
        if (location.pathname !== path) return;
        const id = decodeURIComponent(location.pathname.split('/')[2] || '');
        const chat = engine.state().projects.find(p => p.kind === 'chat' && p.id === id);
        document.body.classList.add('rc-chat-active');
        document.body.classList.toggle('rc-chat-home-view', !chat);
        document.body.classList.toggle('rc-chat-unavailable', !!id && !chat);
        document.body.classList.remove('rc-chat-nav-open', 'rc-chat-panel-open', 'rc-bot-setup');
        if (chat) {
          showArchived = !!chat.archivedAt;
          await engine.select(chat.id, chat.lastSessionId);
          if (location.pathname !== path) return;
          room.openChat(); sync();
        } else {
          active = ''; cleanupPreview(); room.openChat(); renderChats();
          $('rcChatWelcome').querySelector('h1').textContent = id ? 'Chat unavailable' : 'What are we working on?';
          $('rcChatWelcome').querySelector('p').textContent = id ? 'Choose another chat from the sidebar or start a new one.' : 'Start a conversation, bring your files, and pick up where you left off.';
        }
        $('crChatTab').setAttribute('aria-current', 'page');
      } catch (error) { notify(error); }
      finally { routing = false; }
    });
    return routeQueue;
  }
  function open(chat) { return navigate(chatPath(chat.id)); }
  function leave(updateURL = true, keepRoom = false) {
    if (updateURL && inChat()) window.history.pushState({}, '', '/');
    document.body.classList.remove('rc-chat-active','rc-chat-home-view','rc-chat-unavailable','rc-chat-nav-open','rc-chat-panel-open','rc-bot-setup','rc-bot-chat','rc-bot-system-history');
    if ($('rcBotHead')) $('rcBotHead').hidden = true;
    stopNeeds(); closeToday(); if ($('rcBotQuick')) $('rcBotQuick').hidden = true;
    $('crChatTab')?.removeAttribute('aria-current'); cleanupPreview(); if (!keepRoom) room.showBoard();
  }
  function closePanel() {
    if (!document.body.classList.contains('rc-chat-panel-open')) return false;
    document.body.classList.remove('rc-chat-panel-open'); $('rcChatFiles')?.focus(); return true;
  }
  function renderChats() {
    const query = $('rcChatSearch').value.toLowerCase(), state = engine.state();
    const filter = $('rcChatProjectFilter');
    const chats = state.projects.filter(p => p.kind === 'chat' && (!filter?.value || (filter.value==='standalone'?!p.spaceId:p.spaceId===filter.value)) && !!p.archivedAt === showArchived && (p.name + ' ' + p.conversations?.[0]?.title).toLowerCase().includes(query));
    chats.sort((a,b) => (!!b.bot - !!a.bot) || (b.conversations?.[0]?.lastMessageAt || b.conversations?.[0]?.createdAt || 0) - (a.conversations?.[0]?.lastMessageAt || a.conversations?.[0]?.createdAt || 0));
    $('rcChatArchives').textContent = showArchived ? 'Active chats' : 'Archived chats';
    $('rcChatList').innerHTML = chats.map(p => `<a class="rc-chat-item ${p.id === active ? 'selected' : ''}" href="${chatPath(p.id)}" data-chat-link data-chat="${esc(p.id)}" ${(p.conversations?.[0]?.sessionId || p.lastSessionId) ? `data-conv-project="${esc(p.id)}" data-conv-session="${esc(p.conversations?.[0]?.sessionId || p.lastSessionId)}"` : ''} ${p.id === active ? 'aria-current="page"' : ''}><strong>${p.bot ? orb(16, p.running ? 'working' : 'idle') + '<span class="rc-bot-badge">' + esc(botName) + '</span>' : ''}${esc(p.conversations?.[0]?.title || p.name)}</strong><small>${esc(p.provider === 'codex' ? 'Codex' : 'Claude')}${p.running ? ' · Working' : ''}</small>${p.bot ? botBadgeHTML('rc-bot-ind') : ''}</a>`).join('') || '<p class="rc-chat-empty">No chats found.</p>';
  }
  function sync() {
    if (!mounted) return;
    if (inBot()) return;
    if (!inChat()) { if (!routing && current() && room.isOpen() && !window.rcProjectSpaces?.handles(location.pathname)) navigate(chatPath(current().id)); return; }
    if (document.body.classList.contains('rc-chat-home-view')) { renderChats(); return; }
    const chat = current();
    if (!chat) { document.body.classList.remove('rc-chat-active'); active = ''; if (!routing) window.history.pushState({}, '', '/'); return; }
    if (room.isOpen()) document.body.classList.add('rc-chat-active');
    $('rcChatProvider').textContent = chat.provider === 'codex' ? 'Codex' : 'Claude';
    if (active !== chat.id) { active = chat.id; selectedFile = ''; selectedVersion = ''; files = []; loadFiles(); }
    renderChats(); renderUploads(); renderBotHead(chat);
  }
  function loadBot() { return botRequest = request('/api/bot').then(data => { bot = data; takeBot(data); return data; }); }
  // A /api/bot reply (GET or POST): name and attention, plus the row's copy.
  function takeBot(data) { if (data && typeof data === 'object') applyBot({ name: data.name, attention: 'attention' in data ? data.attention ?? {} : undefined }); }
  // Relabel what rc-chat itself owns (workspace.js listens for x056:bot and relabels the sidebar and top bars).
  function paintBotNames() {
    const n = botName, set = (id, v) => { const e = $(id); if (e && e.textContent !== v) e.textContent = v; };
    document.querySelectorAll('#rcBotHead .rc-bot-badge').forEach(e => { if (e.textContent !== n) e.textContent = n; });
    if (document.body.classList.contains('rc-bot-chat')) document.querySelectorAll('#chat>.msg.assistant>.role .role-name').forEach(e => { if (e.textContent !== n) e.textContent = n; });
    const settings = $('rcBotSettings'); if (settings) { settings.setAttribute('aria-label', n + ' settings'); settings.title = n + ' settings'; }
    const title = $('rcBotSetupTitle'); if (title) title.textContent = n === 'Bot' ? 'Set up your Bot' : 'Set up ' + n;
    const enable = $('rcBotSetupForm')?.querySelector('button[type=submit]'); if (enable && !enable.disabled) enable.textContent = 'Enable ' + n;
    $('rcBotHero')?.setAttribute('aria-label', n + ' welcome');
    if ($('rcBotHead')) syncBotWork();
    if (mounted && $('rcChatList')) renderChats();
    set('rcBotNameTitle', n);
  }
  function showBotSetup(data, error) {
    active = ''; cleanupPreview();
    document.body.classList.add('rc-chat-active', 'rc-chat-home-view', 'rc-bot-setup');
    document.body.classList.remove('rc-chat-unavailable', 'rc-chat-nav-open', 'rc-chat-panel-open', 'rc-bot-chat');
    $('rcBotHead').hidden = true; stopNeeds(); closeToday(); $('rcBotQuick').hidden = true; $('crChatTab')?.removeAttribute('aria-current');
    room.openChat();
    const form = $('rcBotSetupForm');
    if (data?.briefAt) form.elements.briefAt.value = data.briefAt;
    form.querySelector('.rc-bot-tz').textContent = (data?.tz || 'Asia/Jakarta') + ' time';
    form.querySelector('[role=alert]').textContent = error ? 'Could not load the ' + botName + ': ' + error : '';
  }
  async function enableBot(event) {
    event.preventDefault();
    const form = event.target, button = form.querySelector('button[type=submit]'), alert = form.querySelector('[role=alert]'), briefAt = form.elements.briefAt.value;
    alert.textContent = '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(briefAt)) { alert.textContent = 'Choose a brief time, such as 07:30.'; form.elements.briefAt.focus(); return; }
    button.disabled = true; button.textContent = 'Enabling…'; form.querySelector('.bot-orb').dataset.state = 'working';
    try {
      const data = await request('/api/bot', { enabled: true, briefAt });
      bot = data; botRequest = Promise.resolve(data); takeBot(data);
      if (!data.enabled || !data.url) throw new Error('The ' + botName + ' did not start. Try again.');
      await engine.reloadProjects();
      await navigate(data.url, true);
    } catch (error) { alert.textContent = error.message || 'Could not enable the Bot.'; }
    finally { button.disabled = false; button.textContent = 'Enable ' + botName; form.querySelector('.bot-orb').dataset.state = 'idle'; }
  }
  function renderBotHead(chat) {
    const head = $('rcBotHead'); if (!head) return;
    const on = !!chat?.bot && room.isOpen() !== false && !document.body.classList.contains('rc-chat-home-view');
    const entering = on && !document.body.classList.contains('rc-bot-chat');
    head.hidden = !on; document.body.classList.toggle('rc-bot-chat', on);
    if (!on) document.body.classList.remove('rc-bot-system-history');
    if (entering) syncBotSystemHistory();
    syncBotHero(); if (!on) { stopNeeds(); closeToday(); syncBotQuick(); return; }
    syncBotWork(); syncBotQuick();
    if (!bot && !botRequest) loadBot().then(() => renderBotHead(current()), () => {});
    const at = $('rcBotBriefAt'), next = nextBrief();
    at.textContent = next;
    at.title = bot?.briefAt ? 'Morning brief at ' + bot.briefAt + ', ' + (bot.tz || 'Asia/Jakarta') + ' time' : '';
    if (!wasBot) { wasBot = true; loadOverview(); }
    startNeeds();
  }
  // ---- Bot chat history: which rows are hidden until "Show N hidden messages".
  // THE RULE. server/bot-view.ts is the shared spec: it annotates the same rows with `botView`
  // ('show' | 'hide'), which iOS filters on. This file applies it to the DOM, so live rows get it
  // too; test/browser/bot-system-history.cjs and test/bot-view.test.ts pin the same table. Change both together.
  // The chat is read in turns. A turn starts at every NON-steered user message (.msg.user) and its
  // kind is that message's sender kind:
  //   'bot_event'  the gateway's digest
  //   'bot_brief'  the morning brief
  //   'advisor'    an advisor follow-up
  //   'agent'      another conversation, an MCP caller, a delegate, a scheduled task (sender kinds
  //                conversation, mcp, delegate, automation: the Bot's own message_self and cron too)
  //   ''           the owner, a recap, autopilot, anything else
  // Rows before the first user message are in a '' turn. A STEERED user row (.msg.user.steered) never
  // starts a turn: from anything but the owner (an agent, the advisor, the digest, the brief) it is 'steer' (hidden,
  // itself only); from the owner (no sender, recap, autopilot) it is 'keep'.
  // Every row has one kind (botRowKind):
  //   'keep'    a question card, an orphaned-turn card, an error banner, an owner message (the Bot's
  //             message_owner bubble), a Bot notice that needs the owner (bot-notice: id + urgent), the
  //             owner's own steer
  //   'system'  a relay checkpoint ("Not sent yet ..." / "Relay checkpoint ..."), a system line,
  //             a non-error banner, a non-urgent Bot notice (by its bot-notice: id, never by its text:
  //             the Bot can be renamed)
  //   'steer'   an agent's steer into a running turn
  //   'trigger' the user message that starts the turn
  //   'reply'   an assistant message
  //   'tool'    a tool row
  //   'other'   anything else (advisor card, other notices, model mark, summary)
  // Decided in this order, first match wins:
  //   1. 'keep' is always shown.
  //   2. 'system' and 'steer' are always hidden, in every turn, an owner's included.
  //   3. A digest ('bot_event') or agent ('agent') turn hides everything else: the agent's message,
  //      the Bot's reply to it, its tools. Whatever the Bot wants the owner to see is a 'keep' row.
  //   4. A morning-brief turn ('bot_brief') shows only its LAST reply (the brief itself),
  //      labelled "Morning brief". Earlier replies are commentary before its tools ("Checking
  //      what ran overnight...") and are hidden with the trigger, the tools and the rest.
  //   5. An advisor turn ('advisor') hides only its trigger.
  //   6. Everything else is shown, so an owner's turn keeps its message, replies and tools.
  // lastReply: for a 'reply', whether it is the last reply of its turn (only rule 4 asks).
  function botRowVisibility(rowKind, turnKind, lastReply) {
    if (rowKind === 'keep') return 'show';
    if (rowKind === 'system' || rowKind === 'steer') return 'hide';
    if (turnKind === 'bot_event' || turnKind === 'agent') return 'hide';
    if (turnKind === 'bot_brief') return rowKind === 'reply' && lastReply !== false ? 'show' : 'hide';
    if (turnKind === 'advisor') return rowKind === 'trigger' ? 'hide' : 'show';
    return 'show';
  }
  const CHECKPOINT = /^(?:Not sent yet(?: \(relay checkpoint\))?[:.]|Relay checkpoint[:.])/i;
  const AGENT_SENDERS = ['conversation', 'mcp', 'delegate', 'automation'];
  // A steer from any of these is not the owner's (the server's NOT_OWNER_STEER); recap and autopilot steers are.
  const NOT_OWNER_STEER = [...AGENT_SENDERS, 'advisor', 'bot_event', 'bot_brief'];
  const senderKindOf = row => (/(?:^|\s)sender-(\w+)/.exec(row.className) || [])[1] || '';
  function botRowKind(row) {
    if (row.matches('.qcard,.orphan,.banner.err,.msg.assistant.owner-message')) return 'keep';
    if (row.matches('.notice')) { const id = row.dataset.messageSourceId || ''; if (id.startsWith('bot-notice:')) return row.dataset.botUrgent ? 'keep' : 'system'; }
    if (row.matches('.msg.user')) return !row.classList.contains('steered') ? 'trigger' : NOT_OWNER_STEER.includes(senderKindOf(row)) ? 'steer' : 'keep';
    if (CHECKPOINT.test(row._messageText ?? row.textContent.trim())) return 'system';
    if (row.matches('.sysline,.banner')) return 'system';
    if (row.matches('.msg.assistant')) return 'reply';
    if (row.matches('.act')) return 'tool';
    return 'other';
  }
  const turnKindOf = row => { const k = senderKindOf(row); return k === 'bot_event' || k === 'bot_brief' || k === 'advisor' ? k : AGENT_SENDERS.includes(k) ? 'agent' : ''; };
  // Who a hidden exchange is with, for the label on its rows while they are shown.
  const exchangeOf = (row, turnKind) => turnKind === 'agent' || turnKind === 'bot_event' ? (row.querySelector('.message-sender strong')?.textContent.trim() || (turnKind === 'agent' ? 'an agent' : 'the digest')) : '';
  // A row's kind is fixed once it is rendered (messages are never edited in place), so it is
  // classified once. The last turn is re-walked on every pass anyway, which heals a row that did change.
  const rowKinds = new WeakMap(), rowShown = new WeakMap(), rowExchange = new WeakMap();
  let hiddenRows = 0;
  function walkBotRows(from, turnKind, full) {
    let hidden = 0, briefReply = null, exchange = '';
    // The label goes on the brief turn's LAST reply (the brief itself; earlier ones are
    // commentary before its tools), so it is placed when the turn ends and moves forward
    // as replies arrive.
    const endTurn = () => { if (briefReply) setRowState(briefReply, 'brief'); briefReply = null; };
    for (let row = from; row; row = row.nextElementSibling) {
      let kind = rowKinds.get(row);
      if (!kind || !row.nextElementSibling) { kind = botRowKind(row); rowKinds.set(row, kind); }
      if (kind === 'trigger') { endTurn(); turnKind = turnKindOf(row); exchange = exchangeOf(row, turnKind); }
      const hide = botRowVisibility(kind, turnKind) === 'hide';
      if (hide) hidden++;
      if (kind === 'reply' || kind === 'keep') nameBotRow(row);
      // A newer reply in a brief turn demotes the previous one to commentary (rule 4).
      if (!hide && kind === 'reply' && turnKind === 'bot_brief') { if (briefReply) { setRowState(briefReply, botRowVisibility('reply', turnKind, false)); hidden++; } briefReply = row; continue; }
      setRowState(row, hide ? 'hide' : 'show', kind === 'steer' ? senderName(row) : exchange);
    }
    endTurn();
    if (full) hiddenRows = hidden;
  }
  const senderName = row => row.querySelector('.message-sender strong')?.textContent.trim() || '';
  // In the Bot chat its replies are signed with its display name, not the provider ("claude").
  function nameBotRow(row) { const e = row.querySelector(':scope>.role .role-name'); if (e && e.textContent !== botName) e.textContent = botName; }
  function setRowState(row, state, exchange = '') {
    let was = rowShown.get(row);
    if (was === undefined) was = row.classList.contains('bot-system-notice') ? 'hide' : row.classList.contains('bot-brief-reply') ? 'brief' : 'show';
    if (rowShown.get(row) !== state) {
      rowShown.set(row, state);
      if ((state === 'hide') !== (was === 'hide')) { row.classList.toggle('bot-system-notice', state === 'hide'); hiddenRows += state === 'hide' ? 1 : -1; }
      if ((state === 'brief') !== (was === 'brief')) briefLabel(row, state === 'brief');
    }
    const ex = state === 'hide' ? exchange : '';
    if ((rowExchange.get(row) ?? '') !== ex) { rowExchange.set(row, ex); exchangeLabel(row, ex); }
  }
  // While hidden rows are shown, an agent exchange reads as one: its rows share a rule on the left, and its
  // replies say who they answer (CSS prints the role line's data-exchange).
  function exchangeLabel(row, ex) {
    row.classList.toggle('bot-agent-row', !!ex);
    const role = row.matches('.msg.assistant') ? row.querySelector(':scope>.role') : null;
    if (role) { if (ex) role.dataset.exchange = ex; else delete role.dataset.exchange; }
  }
  // The "Morning brief" label replaces the role line ("Claude") of the brief's first reply.
  function briefLabel(row, on) {
    row.classList.toggle('bot-brief-reply', on);
    const role = row.querySelector(':scope>.role'); if (!role) return;
    if (!role.querySelector(':scope>.bot-role-name')) { const name = document.createElement('span'); name.className = 'bot-role-name'; name.append(...role.childNodes); role.append(name); }
    role.querySelector(':scope>.bot-brief-tag')?.remove();
    if (on) role.insertAdjacentHTML('afterbegin', `<span class="bot-brief-tag">${SVG.sun}Morning brief</span>`);
  }
  // Called with mutation records for rows the panel added, or with none for a full pass
  // (history loaded, Bot chat opened). Appended rows re-walk only from the start of the
  // last turn before them; removals and rows inserted above others re-walk everything.
  function syncBotSystemHistory(records) {
    if (!document.body.classList.contains('rc-bot-chat')) return;
    const chat = $('chat'); let start = null;
    if (records) {
      for (const record of records) {
        if (record.target !== chat) continue;
        if (record.removedNodes.length || record.nextSibling) { start = undefined; break; }
        const added = [...record.addedNodes].find(n => n.nodeType === 1);
        if (added && added.parentNode === chat && (!start || start.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_PRECEDING)) start = added;
      }
      if (start === null) return;
    }
    if (!start) walkBotRows(chat.firstElementChild, '', true);
    else {
      let turn = start.previousElementSibling;
      while (turn && !turn.matches('.msg.user:not(.steered)')) turn = turn.previousElementSibling;
      walkBotRows(turn || chat.firstElementChild, '');
    }
    syncSystemControls();
  }
  // Show / hide the hidden rows (in place, subdued). The state never outlives the Bot chat:
  // leave() and renderBotHead() clear it.
  function setSystemHistory(on) { document.body.classList.toggle('rc-bot-system-history', on); syncSystemControls(); syncBotHero(); }
  function systemHistoryLabel() {
    if (document.body.classList.contains('rc-bot-system-history')) return 'Hide agent and system messages';
    return hiddenRows ? 'Show ' + hiddenRows + ' hidden message' + (hiddenRows === 1 ? '' : 's') : 'No hidden messages';
  }
  function syncSystemControls() {
    const b = $('rcBotSystemHistory'); if (!b) return;
    b.textContent = systemHistoryLabel(); b.disabled = !hiddenRows && !document.body.classList.contains('rc-bot-system-history');
    b.setAttribute('aria-pressed', String(document.body.classList.contains('rc-bot-system-history')));
  }
  // When the next morning brief runs: today's time, or tomorrow's once today's brief has gone out (lastBriefDate is a date in the Bot's zone).
  function nextBrief() {
    if (!bot?.briefAt) return '';
    let today = ''; try { today = new Intl.DateTimeFormat('en-CA', { timeZone: bot.tz || 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch {}
    return 'Next brief ' + (today && bot.lastBriefDate === today ? 'tomorrow ' : '') + bot.briefAt;
  }
  // Header orb and status line: working while the open Bot conversation has a turn or background work (the panel's own #busy bar shows exactly that).
  function syncBotWork() {
    const o = document.querySelector('#rcBotHead .bot-orb'), busy = $('busy'); if (!o) return;
    const state = busy && busy.childElementCount ? 'working' : 'idle';
    $('rcBotStatus').textContent = state === 'working' ? 'Working…' : 'Idle'; $('rcBotHead').querySelector('.rcb-id').dataset.state = state;
    syncBotQuick();
    o.dataset.state = state; const label = botName + (state === 'working' ? ' is working' : ' is idle');
    if (o.getAttribute('aria-label') !== label) { o.setAttribute('aria-label', label); o.title = label; }
  }
  // The quick-action row above the composer: only for a Bot chat that has messages, with nothing typed and no turn running.
  function syncBotQuick() {
    const q = $('rcBotQuick'); if (!q) return;
    const p = $('prompt'), busy = $('busy'), chatEl = $('chat');
    const show = document.body.classList.contains('rc-bot-chat') && !document.body.classList.contains('rc-bot-empty') && !!chatEl && chatEl.childElementCount > 0 && !(busy && busy.childElementCount) && !!p && !p.value.trim() && !$('attachRow')?.childElementCount;
    if (q.hidden === !show) return; q.hidden = !show;
  }
  // "Needs you": polled only while a Bot chat is on screen and the tab is visible.
  const botVisible = () => document.body.classList.contains('rc-bot-chat') && !document.hidden;
  function startNeeds() { if (!needsTimer) needsTimer = setInterval(() => { if (botVisible()) loadOverview(); }, 30000); }
  function stopNeeds() { clearInterval(needsTimer); needsTimer = 0; wasBot = false; }
  async function loadOverview() {
    if (!bot?.sessionId) { try { await (botRequest || loadBot()); } catch { return overview; } }
    if (!bot?.sessionId) return overview;
    try { overview = await request('/api/bot/overview?from=' + encodeURIComponent(bot.sessionId)); overviewAt = Date.now(); } catch { /* keep the last answer */ }
    renderNeeds(); if (todayPop?.isConnected) renderToday(todayPop);
    return overview;
  }
  function renderNeeds() {
    const b = $('rcBotNeeds'); if (!b) return;
    const n = overview?.needsYou?.length || 0; b.hidden = !n; if (!n) return;
    b.querySelector('.rn-count').textContent = n; b.querySelector('.rn-txt').textContent = n === 1 ? ' needs you' : ' need you';
    b.setAttribute('aria-label', n + (n === 1 ? ' thing needs you' : ' things need you') + '. Open Today.'); b.title = 'Open Today';
  }
  const since = iso => { const t = Date.parse(iso || ''); if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' d'; };
  const clip = (text, n) => { text = String(text ?? '').replace(/\s+/g, ' ').trim(); return text.length > n ? text.slice(0, n - 1) + '…' : text; };
  function renderToday(pop) {
    const o = overview, own = bot?.sessionId;
    const needs = o?.needsYou || [], running = (o?.running || []).filter(r => !own || r.sessionId !== own), delegates = o?.delegates || [];
    const failed = (o?.scheduled || []).filter(j => j.lastResult && !/^(queued|delivered|ok)$/i.test(j.lastResult));
    const list = (rows, cap = 5) => rows.slice(0, cap).join('') + (rows.length > cap ? `<li class="rcb-more">+${rows.length - cap} more</li>` : '');
    let html = `<header><strong>Today</strong><span>${esc(nextBrief())}</span></header>`;
    html += `<button type="button" class="rcb-system-history" id="rcBotSystemHistory">${esc(systemHistoryLabel())}</button>`;
    if (!o) html += '<p class="rcb-empty">Checking…</p>';
    else if (!needs.length) html += `<div class="rcb-calm">${orb(40, 'idle').replace('class="bot-orb"', 'class="bot-orb happy"')}<div><strong>Nothing needs you</strong><span>I will tell you when something does.</span></div></div>`;
    else html += `<section><h3>Needs you <b>${needs.length}</b></h3><ul>${list(needs.map(n => `<li class="rcb-need"><span class="rcb-kind">${n.kind === 'approval' ? 'Approval' : 'Question'}</span><strong>${esc(clip(n.title || n.projectName, 60))}</strong><p>${esc(clip(n.text, 150))}</p></li>`))}</ul></section>`;
    if (o && running.length) html += `<section><h3>Running <b>${running.length}</b></h3><ul>${list(running.map(r => `<li><strong>${esc(clip(r.title || r.projectName, 50))}</strong><span>${esc(r.projectName && r.title ? clip(r.projectName, 24) + ' · ' : '')}${r.state === 'background' ? 'Background' : 'Working'}${r.since ? ' · ' + esc(since(r.since)) : ''}</span></li>`))}</ul></section>`;
    if (o && delegates.length) html += `<section><h3>Delegates <b>${delegates.length}</b></h3><ul>${list(delegates.map(d => `<li><strong>${esc(clip(d.role, 40))}</strong><span>${d.working ? 'Working' : esc(d.status || '')}${d.orchestratorTitle ? ' · ' + esc(clip(d.orchestratorTitle, 30)) : ''}</span></li>`))}</ul></section>`;
    if (o && failed.length) html += `<section><h3>Failed schedules <b>${failed.length}</b></h3><ul>${list(failed.map(j => `<li class="rcb-fail"><strong>${esc(clip(j.label || j.schedule, 50))}</strong><span>${esc(clip(j.lastResult, 80))}${j.lastRunAt ? ' · ' + esc(since(j.lastRunAt)) + ' ago' : ''}</span></li>`))}</ul></section>`;
    if (o && !running.length && !delegates.length && !failed.length) html += '<p class="rcb-empty">Nothing running right now.</p>';
    pop.innerHTML = html;
    $('rcBotSystemHistory').onclick = () => { setSystemHistory(!document.body.classList.contains('rc-bot-system-history')); closeToday(true); };
    syncSystemControls();
  }
  function toggleToday() { todayPop?.isConnected ? closeToday(true) : openToday(); }
  function openToday() {
    // On a phone the calendar button gives way to the "needs you" chip, which then anchors Today.
    const anchor = [$('rcBotToday'), $('rcBotNeeds')].find(e => e && e.offsetParent !== null); if (!anchor) return;
    const pop = document.createElement('div'); pop.id = 'rcBotTodayPop'; pop.className = 'rcb-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Today'); pop.tabIndex = -1;
    document.body.append(pop); todayPop = pop; renderToday(pop);
    const r = anchor.getBoundingClientRect(), w = Math.min(360, innerWidth - 20);
    pop.style.top = Math.round(r.bottom + 8) + 'px'; pop.style.left = Math.max(10, Math.min(innerWidth - w - 10, r.right - w)) + 'px';
    anchor.setAttribute('aria-expanded', 'true'); pop.focus({ preventScroll: true });
    const away = event => { if (!pop.contains(event.target) && !event.target.closest?.('#rcBotToday,#rcBotNeeds')) closeToday(); };
    const keys = event => { if (event.key === 'Escape') { event.stopPropagation(); closeToday(true); } };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', keys, true);
    pop._off = () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', keys, true); };
    loadOverview();
  }
  function closeToday(refocus = false) {
    const pop = todayPop; if (!pop) return; todayPop = null; pop._off?.(); pop.remove();
    $('rcBotToday')?.setAttribute('aria-expanded', 'false'); $('rcBotNeeds')?.setAttribute('aria-expanded', 'false'); if (refocus) [$('rcBotToday'), $('rcBotNeeds')].find(e => e && e.offsetParent !== null)?.focus();
  }
  // Bot settings: the setup card's look again (orb, aurora), the brief time, and the on/off switch.
  function openSettings() {
    closeToday();
    const on = bot?.enabled !== false;
    const d = dialog(botName + ' settings', `<form class="rcb-settings" novalidate><div class="rcb-hero"><span class="bot-aurora" aria-hidden="true"></span>${orb(72)}<p>${esc(botName)} briefs you every morning and messages you when something needs you.</p></div><label class="rc-bot-time rc-bot-namefield">Name<input type="text" name="name" value="${esc(botName)}" maxlength="40" autocomplete="off" spellcheck="false" aria-describedby="rcBotNameHint"></label><small id="rcBotNameHint" class="rc-bot-tz">What the panel and the app call it. 1 to 40 characters.</small><label class="rc-bot-time">Morning brief<input type="time" name="briefAt" value="${esc(bot?.briefAt || '07:30')}" required></label><small class="rc-bot-tz">${esc(bot?.tz || 'Asia/Jakarta')} time</small><p class="rc-bot-error" role="alert"></p><button class="cr-primary" type="submit">Save</button><div class="rcb-off"><div><strong>${esc(botName)} is ${on ? 'on' : 'off'}</strong><span>${on ? 'Turning it off stops morning briefs and notices. The chat stays.' : 'Turn it on to get morning briefs again.'}</span></div><button type="button" class="cr-secondary" data-toggle>${on ? 'Turn ' + esc(botName) + ' off' : 'Turn ' + esc(botName) + ' on'}</button></div></form>`, 'rc-bot-settings');
    const form = d.querySelector('form'), alert = form.querySelector('[role=alert]'), save = form.querySelector('button[type=submit]'), toggle = form.querySelector('[data-toggle]');
    let armed = 0;
    form.onsubmit = async event => {
      event.preventDefault(); alert.textContent = ''; const briefAt = form.elements.briefAt.value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(briefAt)) { alert.textContent = 'Choose a brief time, such as 07:30.'; form.elements.briefAt.focus(); return; }
      save.disabled = true; save.textContent = 'Saving…'; form.querySelector('.bot-orb').dataset.state = 'working';
      const name = form.elements.name.value.trim(), body = { briefAt }; if (name !== botName) body.name = name;
      try { bot = await request('/api/bot', body); botRequest = Promise.resolve(bot); takeBot(bot); renderBotHead(current()); save.textContent = 'Saved'; happy(); setTimeout(() => d.isConnected && d.close(), 700); }
      catch (error) { alert.textContent = error.message || 'Could not save.'; save.textContent = 'Save'; save.disabled = false; }
      finally { form.querySelector('.bot-orb') && (form.querySelector('.bot-orb').dataset.state = 'idle'); }
    };
    toggle.onclick = async () => {
      if (on && !armed) { armed = setTimeout(() => { armed = 0; toggle.textContent = 'Turn ' + botName + ' off'; }, 4000); toggle.textContent = 'Tap again to turn off'; return; }
      clearTimeout(armed); toggle.disabled = true; alert.textContent = '';
      try {
        const data = await request('/api/bot', { enabled: !on }); bot = data; botRequest = Promise.resolve(data); takeBot(data); overview = null;
        d.close(); await engine.reloadProjects();
        await navigate(on || !data.url ? '/bot' : data.url, true);
      } catch (error) { alert.textContent = error.message || 'Could not change ' + botName + '.'; toggle.disabled = false; toggle.textContent = on ? 'Turn ' + botName + ' off' : 'Turn ' + botName + ' on'; armed = 0; }
    };
  }
  // The hero shows for the open Bot chat once its history has loaded and the thread has no nodes; the first message removes it.
  function syncBotHero() {
    const s = engine.state(), chatEl = $('chat');
    // Empty = nothing on screen: no rows, or only system rows while they are hidden (a Bot whose
    // first turns were all digests would otherwise show a blank page).
    const rows = chatEl ? chatEl.childElementCount - (document.body.classList.contains('rc-bot-system-history') ? 0 : hiddenRows) : 1;
    const empty = document.body.classList.contains('rc-bot-chat') && !!s.sessionId && !!s.views?.[s.projectId + '::' + s.sessionId]?.loaded && rows <= 0;
    syncBotQuick();
    if (empty === document.body.classList.contains('rc-bot-empty')) return;
    if (empty) {
      let hour = new Date().getHours();
      try { hour = +new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: bot?.tz || 'Asia/Jakarta' }).format(new Date()); } catch {}
      $('rcBotGreeting').textContent = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    }
    document.body.classList.toggle('rc-bot-empty', empty); syncBotQuick();
  }
  function leanEyes(event) {
    if (!document.body.classList.contains('rc-bot-empty')) return;
    leanEvent = event; if (leanFrame) return;
    leanFrame = requestAnimationFrame(() => {
      leanFrame = 0; const o = document.querySelector('#rcBotHero .bot-orb'); if (!o) return;
      const r = o.getBoundingClientRect(), dx = leanEvent.clientX - r.left - r.width / 2, dy = leanEvent.clientY - r.top - r.height / 2, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 160) * 3 / d;
      o.style.setProperty('--lx', (dx * k).toFixed(2) + 'px'); o.style.setProperty('--ly', (dy * k).toFixed(2) + 'px');
    });
  }
  function happy() {
    document.querySelectorAll('#rcBotHead .bot-orb, #rcBotHero .bot-orb').forEach(o => { o.classList.remove('happy'); void o.offsetWidth; o.classList.add('happy'); setTimeout(() => o.classList.remove('happy'), 1500); });
  }
  const BRIEF_LABEL = { idle: 'Brief me now', busy: 'Requesting…', done: 'Brief requested' };
  function setBriefState(state) {
    document.querySelectorAll('.rc-brief').forEach(b => {
      b.dataset.state = state; b.disabled = state === 'busy'; b.querySelector('.rb-label').textContent = BRIEF_LABEL[state];
      if (state === 'busy') b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    });
  }
  async function briefNow() {
    if (briefing) return;
    const status = $('rcBotBriefStatus');
    briefing = true; clearTimeout(briefTimer); clearTimeout(doneTimer);
    status.classList.remove('error'); status.textContent = 'Asking…'; setBriefState('busy');
    try { await request('/api/bot/brief', {}); status.textContent = 'Brief requested'; setBriefState('done'); happy(); doneTimer = setTimeout(() => setBriefState('idle'), 2200); }
    catch (error) { status.classList.add('error'); status.textContent = error.message || 'Brief failed'; setBriefState('idle'); }
    finally { briefing = false; briefTimer = setTimeout(() => { status.textContent = ''; status.classList.remove('error'); }, 5000); }
  }
  function newChat() {
    const d = dialog('New chat', `<form class="workspace-form"><p class="rc-chat-note">Start with your saved choices. You can change them here or from the composer.</p><details class="rc-chat-new-options"><summary>Provider, model, effort, and account</summary><div class="rc-chat-form-grid"><label>Provider<select name="provider"><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>Account<select name="account"></select></label><label>Model<select name="model"></select></label><label>Effort<select name="effort"></select></label></div></details><p class="rc-chat-note">The chat is named from your first message. Automatic account selection keeps work moving across available accounts.</p><p role="alert"></p><button class="cr-primary">Start chat</button></form>`);
    const form = d.querySelector('form'), f = form.elements, requestId = crypto.randomUUID();
    let saved={};try{saved=JSON.parse(localStorage.getItem('x056_new_chat_choices')||'{}');}catch{}if(saved.provider)f.provider.value=saved.provider;
    function choices() {
      f.model.innerHTML = '<option value="">Provider default</option>' + engine.defaultModelOptions(f.provider.value).map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');
      f.account.innerHTML = '<option value="">Automatic</option>' + engine.state().accounts.filter(a => a.provider === f.provider.value).map(a => `<option value="${esc(a.name)}">${esc(a.label || a.displayName || a.name)}</option>`).join('');if(saved.provider===f.provider.value){f.model.value=saved.model||'';f.account.value=saved.account||'';}efforts();if(saved.provider===f.provider.value)f.effort.value=saved.effort||'';
    }
    function efforts() { const m = engine.defaultModelOptions(f.provider.value).find(m => m.value === f.model.value); f.effort.innerHTML = (m?.efforts || [{ value:'', label:'Provider default' }]).map(e => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join(''); }
    f.provider.onchange = choices; f.model.onchange = efforts; choices();
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
      try { try{localStorage.setItem('x056_new_chat_choices',JSON.stringify({provider:f.provider.value,model:f.model.value,effort:f.effort.value,account:f.account.value}));}catch{}const chat = await request('/api/chats', { requestId, provider:f.provider.value, model:f.model.value, effort:f.effort.value, account:f.account.value || undefined }); await engine.reloadProjects(); await open(chat); d.close(); }
      catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { button.disabled = false; }
    };
  }
  async function chatActions() {
    const chat = current(); if (!chat) return;
    const d = dialog('Chat actions', `<p class="rc-chat-action-title">${esc(chat.conversations?.[0]?.title || chat.name)}</p><div class="rc-chat-action-list"><button data-rename>${icon('edit')}<span><strong>Rename chat</strong><small>Give this conversation a name</small></span></button><button data-copy>${icon('link')}<span><strong>Copy link</strong><small>Open this chat on another device</small></span></button><button data-controls>${icon('controls')}<span><strong>Conversation controls</strong><small>Manage this conversation</small></span>${icon('chevron')}</button><button data-archive>${icon('archive')}<span><strong>${chat.archivedAt ? 'Restore chat' : 'Archive chat'}</strong><small>${chat.archivedAt ? 'Move back to your active chats' : 'Keep the conversation and its files'}</small></span></button></div>`, 'rc-chat-actions-dialog');
    d.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(location.origin + chatPath(chat.id)); d.close(); notify('Chat link copied.'); } catch (e) { notify(e); } };
    d.querySelector('[data-controls]').onclick = () => { d.close(); room.conversationMenu($('rcChatMore')); };
    d.querySelector('[data-rename]').onclick = async () => { d.close(); const name = await engine.prompt({ title:'Rename chat', value:chat.conversations?.[0]?.title || chat.name }); if (name) try { await request(base(chat.id), { name }); await engine.reloadProjects(); sync(); } catch (e) { notify(e); } };
    d.querySelector('[data-archive]').onclick = async () => { try { await request(base(chat.id), { archived:!chat.archivedAt }); d.close(); await engine.reloadProjects(); if (!chat.archivedAt) await navigate('/chat'); else { showArchived = false; sync(); } } catch (e) { notify(e); } };
  }
  async function upload(file) {
    const chat = current(); if (!chat) return;
    const job = { id:crypto.randomUUID(), chatId:chat.id, sessionId:chat.lastSessionId, file, progress:0, state:'uploading', controller:new AbortController() }; jobs.set(job.id, job); runUpload(job);
  }
  async function runUpload(job) {
    job.state = 'uploading'; job.controller = new AbortController(); renderUploads();
    try {
      const data = await engine.uploadBinary(base(job.chatId) + '/files', job.file, job.id, progress => { job.progress = progress; renderUploads(); }, job.controller.signal);
      for (const file of data.files) attach(job.chatId, job.sessionId, file, file.versions.find(v => v.id === file.latestVersionId));
      jobs.delete(job.id); if (active === job.chatId) await loadFiles();
    } catch (error) { job.state = 'failed'; job.error = error.message; }
    renderUploads();
  }
  function attach(chatId, sessionId, file, version) {
    engine.attachSaved(chatId, sessionId, { fileId:file.id, versionId:version.id, name:file.name, type:version.mime || 'application/octet-stream', url:`${base(chatId)}/files/${file.id}/versions/${version.id}/content` });
  }
  function renderUploads() {
    if (!mounted) return;
    $('rcChatUploads').innerHTML = [...jobs.values()].filter(j => j.chatId === active).map(j => `<div class="rc-chat-upload" data-upload="${j.id}"><strong>${esc(j.file.name)}</strong><small>${j.state === 'uploading' ? 'Uploading '+j.progress+'%' : esc(j.error)}</small><progress value="${j.progress}" max="100"></progress><button>${j.state === 'uploading' ? 'Cancel' : 'Retry'}</button>${j.state==='failed'?'<button data-dismiss>Dismiss</button>':''}</div>`).join('');
    $('rcChatUploads').querySelectorAll('[data-upload]').forEach(row => { const job = jobs.get(row.dataset.upload); row.querySelector('button').onclick = () => job.state === 'uploading' ? job.controller.abort() : runUpload(job); const dismiss=row.querySelector('[data-dismiss]');if(dismiss)dismiss.onclick=()=>{jobs.delete(job.id);renderUploads();}; });
  }
  async function loadFiles() {
    const id = active; if (!id) return;
    try { const data = await request(base(id) + '/files'); if (id !== active) return; files = data.files; renderPanel(); }
    catch (error) { if (id === active) $('rcChatPanelBody').textContent = error.message; }
  }
  function cleanupPreview() { sequence++; clearTimeout(previewTimer); objectURLs.forEach(URL.revokeObjectURL); objectURLs = []; }
  function renderPanel() {
    if (!mounted) return; cleanupPreview();
    $('rcChatInspector').querySelectorAll('[data-chat-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.chatTab === tab)));
    if (tab === 'references') { renderReferences(); return; }
    if (tab === 'preview') { renderPreview(); return; }
    const visible = files.filter(file => !!file.removed === showRemoved);
    $('rcChatPanelBody').innerHTML = `<div class="rc-chat-panel-heading"><span>${visible.length} ${showRemoved ? 'removed ' : ''}files</span><button id="rcChatRemoved">${showRemoved ? 'Back to files' : 'Removed'}</button><button id="rcChatUploadButton">+ Upload</button></div>` + visible.map(file => {
      const v = file.versions.find(v => v.id === file.latestVersionId);
      return `<article class="rc-chat-file" data-file="${file.id}"><button data-preview><span class="rc-chat-file-icon">${esc(file.name.split('.').pop().slice(0,5).toUpperCase())}</span><strong>${esc(file.name)}</strong></button><small>v${file.versions.length} · ${Math.max(1,Math.round(v.bytes/1024))} KB · Saved${file.memorySources?.length?' · Used by '+file.memorySources.length+' memory sources; retained after removal':''}</small><div><button data-attach>Attach</button><button data-download>Download</button><button data-history>Versions</button>${window.rcProjectSpaces?.enabled()?'<button data-file-memory>Add to memory</button>':''}${window.rcProjectSpaces?.enabled()&&current()?.spaceId?'<button data-share-project>Add to project</button>':''}<button data-remove>${file.removed ? 'Restore file' : 'Remove'}</button></div></article>`;
    }).join('') + (!visible.length ? '<div class="rc-chat-empty"><strong>Bring your work here</strong><p>Upload a proposal, PDF, or reference file. Saved versions stay with this chat across accounts.</p></div>' : '');
    $('rcChatRemoved').onclick=()=>{showRemoved=!showRemoved;renderPanel();};
    $('rcChatUploadButton').onclick = () => { const input = document.createElement('input'); input.type='file';input.multiple=true;input.onchange=()=>[...input.files].forEach(upload);input.click(); };
    $('rcChatPanelBody').querySelectorAll('[data-file]').forEach(row => {
      const file=files.find(f=>f.id===row.dataset.file),v=file.versions.find(v=>v.id===file.latestVersionId);
      row.querySelector('[data-preview]').onclick=()=>{selectedFile=file.id;selectedVersion=v.id;tab='preview';renderPanel();};
      row.querySelector('[data-download]').onclick=()=>download(file,v);
      row.querySelector('[data-attach]').onclick=()=>{attach(active,current().lastSessionId,file,v);notify('File attached.');};
      if(row.querySelector('[data-file-memory]'))row.querySelector('[data-file-memory]').onclick=()=>room.addFileToMemory(active,file,v.id);
      row.querySelector('[data-history]').onclick=()=>history(file);
      if(row.querySelector('[data-share-project]'))row.querySelector('[data-share-project]').onclick=()=>window.rcProjectSpaces.shareChatFile(current(),file);
      row.querySelector('[data-remove]').onclick=async()=>{try{await request(`${base(active)}/files/${file.id}`,{removed:!file.removed});await loadFiles();}catch(e){notify(e);}};
    });
  }
  async function download(file, version) {
    try { const response=await engine.api(versionURL(file,version)+'/download');if(!response.ok)throw new Error('Download unavailable');const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000); }
    catch(error){notify(error);}
  }
  function history(file) {
    const d=dialog(file.name,`<div class="rc-chat-history">${file.versions.map((v,i)=>`<article data-version="${v.id}"><strong>Version ${i+1}</strong><small>${esc(new Date(v.createdAt).toLocaleString())}</small><button data-view>Preview</button><button data-download>Download</button>${v.id!==file.latestVersionId?'<button data-restore>Restore as new version</button>':''}</article>`).reverse().join('')}</div>`);
    d.querySelectorAll('[data-version]').forEach(row=>{const v=file.versions.find(v=>v.id===row.dataset.version);row.querySelector('[data-download]').onclick=()=>download(file,v);row.querySelector('[data-view]').onclick=()=>{d.close();selectedFile=file.id;selectedVersion=v.id;tab='preview';renderPanel();};const restore=row.querySelector('[data-restore]');if(restore)restore.onclick=async()=>{try{await request(`${base(active)}/files/${file.id}/restore`,{versionId:v.id,expectedBaseVersionId:file.latestVersionId,operationId:crypto.randomUUID()});d.close();loadFiles();}catch(e){notify(e);}};});
  }
  async function renderPreview() {
    const file=files.find(f=>f.id===selectedFile)||files[files.length-1],v=file?.versions.find(v=>v.id===selectedVersion)||file?.versions.find(v=>v.id===file.latestVersionId),serial=sequence;
    const body=$('rcChatPanelBody');if(!file||!v){body.innerHTML='<p class="rc-chat-empty">Choose a file to preview.</p>';return;}
    const url=versionURL(file,v);body.innerHTML=`<div class="rc-chat-preview-heading"><strong>${esc(file.name)}</strong><small>Version ${file.versions.findIndex(x=>x.id===v.id)+1}</small><button id="rcChatPreviewDownload">Download</button></div><div id="rcChatPreviewContent" role="status">Preparing preview…</div>`;
    $('rcChatPreviewDownload').onclick=()=>download(file,v);
    let imageRequest=0;
    async function blobImage(path, host) { const attempt=++imageRequest; const r=await engine.api(path);if(!r.ok)throw new Error('Preview unavailable');const blob=await r.blob();if(serial!==sequence||attempt!==imageRequest)return;const url=URL.createObjectURL(blob);objectURLs.push(url);const img=document.createElement('img');img.src=url;img.alt=file.name+' preview';host.replaceChildren(img); }
    try {
      if(v.mime.startsWith('image/')){await blobImage(url+'/content',$('rcChatPreviewContent'));return;}
      if(v.mime.startsWith('text/')||v.mime==='application/json'){const r=await engine.api(url+'/content',{headers:{Range:'bytes=0-199999'}});if(!r.ok)throw new Error('Preview unavailable');const text=await r.text();if(serial!==sequence)return;const pre=document.createElement('pre');pre.textContent=text+(v.bytes>200000?'\n[Preview truncated. Download for the full file.]':'');$('rcChatPreviewContent').replaceChildren(pre);return;}
      if(!['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(v.mime)){ $('rcChatPreviewContent').textContent='Preview unavailable for this format. Download it or use an available tool.';return; }
      const job=await request(url+'/preview');if(serial!==sequence)return;
      if(job.state==='queued'||job.state==='running'){ $('rcChatPreviewContent').textContent='Preparing document preview…';previewTimer=setTimeout(renderPreview,2000);return; }
      if(job.state!=='ready'){ $('rcChatPreviewContent').textContent=job.error||'Preview unavailable.';const retry=document.createElement('button');retry.textContent='Retry preview';retry.onclick=async()=>{await request(url+'/preview',{});renderPreview();};$('rcChatPreviewContent').append(retry);return; }
      const outputs=JSON.parse(job.output),count=outputs.length-1;let page=1;
      $('rcChatPreviewContent').innerHTML='<div class="rc-chat-page-controls"><button data-prev>Previous</button><span></span><button data-next>Next</button></div><div class="rc-chat-page"></div>';
      const host=$('rcChatPreviewContent'),render=()=>{host.querySelector('span').textContent=`Page ${page} of ${count}${count===30?' (preview limit)':''}`;host.querySelector('[data-prev]').disabled=page===1;host.querySelector('[data-next]').disabled=page===count;blobImage(url+'/preview/'+page,host.querySelector('.rc-chat-page')).catch(notify);};host.querySelector('[data-prev]').onclick=()=>{page--;render();};host.querySelector('[data-next]').onclick=()=>{page++;render();};render();
    }catch(error){if(serial===sequence)$('rcChatPreviewContent').textContent=error.message;}
  }
  async function toolsDialog(target) {
    const explicit=target&&typeof target==='object'&&typeof target.projectId==='string';
    const id = explicit ? target.projectId : typeof target === 'string' ? target : active;
    const sessionId = explicit ? target.sessionId : engine.state().sessionId;
    const execution=engine.state().projects.find(p=>p.id===id),conversation=execution?.conversations?.find(c=>c.sessionId===sessionId),work=execution?.kind!=='chat';
    const capabilitiesURL=(work?'/api/project-spaces/'+encodeURIComponent(id):base(id))+'/capabilities';
    const d = dialog(conversation ? 'Tools · '+conversation.title : 'Tools', `<div class="rc-chat-tools"><div class="rc-tools-toolbar"><label>Account<select id="rcToolsAccount" disabled><option>Loading accounts…</option></select></label><input id="rcToolsSearch" type="search" placeholder="Search tools" aria-label="Search tools"></div><div class="rc-chat-tabs" role="group" aria-label="Tool category"><button data-kind="plugin" aria-pressed="true">Plugins <span></span></button><button data-kind="mcp" aria-pressed="false">MCP <span></span></button><button data-kind="skill" aria-pressed="false">Skills <span></span></button></div><p class="rc-tools-help">Required tools stay with this chat when you switch accounts.</p><div id="rcToolsList" aria-busy="true"><p class="rc-chat-empty" role="status">Checking available tools…</p></div><footer><span id="rcToolsRequired" role="status"></span><button class="cr-secondary" data-refresh>Refresh</button><button class="cr-secondary" data-manage>Manage connections</button></footer></div>`, 'rc-chat-tools-dialog');
    let kind = 'plugin', inventory, requirements = [], projectRequirements = [], saving = false;
    const accountSelect = d.querySelector('#rcToolsAccount'), list = d.querySelector('#rcToolsList'), search = d.querySelector('#rcToolsSearch');
    const accountLabel = name => { const a = engine.state().accounts.find(a => a.name === name); return a?.label || a?.displayName || name; };
    async function load(force = false) {
      const selected = accountSelect.value;
      d.querySelector('[data-refresh]').disabled = true; list.setAttribute('aria-busy', 'true');
      try {
        inventory = await request(capabilitiesURL + '?' + new URLSearchParams({...(work?{sessionId}:{}),...(force?{refresh:'1'}:{})}));
        if (!d.open) return;
        requirements = inventory.requirements; projectRequirements = inventory.projectRequirements || [];
        accountSelect.innerHTML = inventory.accounts.map(a => `<option value="${esc(a.account)}">${esc(accountLabel(a.account))}</option>`).join('');
        const state = engine.state(), preferred = [selected, state.composerAccount, state.runningAccount].find(name => inventory.accounts.some(a => a.account === name));
        accountSelect.value = preferred || inventory.accounts[0]?.account || '';
        accountSelect.disabled = !inventory.accounts.length; render();
      } catch (e) { if (d.open) list.innerHTML = `<p class="rc-tools-error" role="alert">${esc(e.message)}</p>`; }
      finally { list.setAttribute('aria-busy', 'false'); d.querySelector('[data-refresh]').disabled = false; }
    }
    function render() {
      const account = inventory?.accounts.find(a => a.account === accountSelect.value), capabilities = account?.capabilities || [], query = search.value.trim().toLowerCase();
      d.querySelectorAll('[data-kind]').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.kind === kind)); b.querySelector('span').textContent = capabilities.filter(c => c.kind === b.dataset.kind).length; });
      d.querySelector('#rcToolsRequired').textContent = new Set([...requirements,...projectRequirements].map(r=>r.key)).size + ' required' + (projectRequirements.length?' · '+projectRequirements.length+' from Project':'');
      const visible = capabilities.filter(c => c.kind === kind && (c.name + ' ' + (c.description || '')).toLowerCase().includes(query));
      const states = { ready:'Ready', installed:'Installed', 'authorization-needed':'Sign in needed', unavailable:'Unavailable', 'refresh-needed':'Refresh needed' };
      list.innerHTML = (account?.errors || []).map(e => `<p class="rc-tools-error" role="status">${esc(e)}</p>`).join('') + visible.map(c => {
        const inherited = projectRequirements.find(r => r.key === c.key), required = inherited || requirements.find(r => r.key === c.key), mismatch = required?.fingerprint && required.fingerprint !== c.fingerprint;
        return `<article class="rc-chat-capability" data-key="${esc(c.key)}"><div class="rc-capability-heading"><strong>${esc(c.name)}</strong><span class="rc-tool-state ${c.state === 'ready' ? 'ready' : ''}">${esc(states[c.state] || c.state.replaceAll('-', ' '))}</span></div>${c.description ? `<p>${esc(c.description)}</p>` : ''}${mismatch ? '<p class="rc-tools-error">This account has a different version.</p>' : ''}<div class="rc-capability-actions"><label><input type="checkbox" ${required ? 'checked' : ''} ${saving || inherited ? 'disabled' : ''}>${inherited?'Required by Project':'Required for this chat'}</label>${c.invocation ? `<button class="cr-secondary" data-invoke ${c.state !== 'ready' || saving ? 'disabled' : ''}>Use skill</button>` : ''}</div></article>`;
      }).join('') + (!visible.length ? `<div class="rc-chat-empty" role="status"><strong>${query ? 'No matching tools' : 'No ' + ({plugin:'plugins',mcp:'MCP servers',skill:'skills'}[kind]) + ' available'}</strong><p>${query ? 'Try another name or category.' : 'Choose another account or manage its connections.'}</p></div>` : '');
      list.querySelectorAll('[data-key]').forEach(row => {
        const capability = capabilities.find(c => c.key === row.dataset.key);
        async function save(required, invoke = false) {
          if (saving) return; saving = true;
          const before = requirements;
          requirements = requirements.filter(r => r.key !== capability.key);
          if (required) requirements.push({key:capability.key, fingerprint:capability.fingerprint});
          d.querySelector('[data-refresh]').disabled = true; render();
          try {
            await request(capabilitiesURL, {requirements,...(work?{sessionId}:{})});
            if (invoke && d.open) { engine.insertPrompt(capability.invocation + ' '); d.close(); }
          } catch (e) { requirements = before; notify(e); }
          finally { saving = false; if (d.open) { render(); d.querySelector('[data-refresh]').disabled = false; } }
        }
        row.querySelector('input').onchange = event => save(event.target.checked);
        const use = row.querySelector('[data-invoke]'); if (use) use.onclick = () => save(true, true);
      });
    }
    d.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { kind = b.dataset.kind; render(); });
    accountSelect.onchange = render; search.oninput = render;
    d.querySelector('[data-refresh]').onclick = () => load(true);
    d.querySelector('[data-manage]').onclick = () => { d.close(); room.showSettings('connections'); };
    load();
  }
  function referencePicker() {
    const id = active, chat = current(); if (!chat) return;
    const d = dialog('Reference conversations', '<div class="rc-reference-picker"><input type="search" placeholder="Search projects and conversations" aria-label="Search references"><div class="rc-chat-reference-list"></div><footer><span id="rcReferenceSelection" role="status">Select conversations to reference</span><button class="cr-primary" id="rcReferenceAdd" disabled>Add selected</button></footer></div>', 'rc-chat-reference-dialog');
    const selected = new Map();
    function render() {
      const query = d.querySelector('input').value.trim().toLowerCase(), references = chat.references || [], host = d.querySelector('.rc-chat-reference-list');
      const sources = engine.state().projects.filter(p => p.id !== id), matching = p => (p.conversations || []).filter(c => (p.name + ' ' + c.title + ' ' + (window.rcProjectSpaces?.list()?.find(s=>s.id===window.rcProjectSpaces.scopeOf(p,c.sessionId))?.name||'')).toLowerCase().includes(query)).map(c => ({p,c}));
      const grouped = window.rcProjectSpaces?.enabled(), primary = window.rcProjectSpaces?.scopeOf;
      const spaceRows = grouped ? window.rcProjectSpaces.list().map(space=>({id:space.id,name:space.name,rows:sources.flatMap(matching).filter(({p,c})=>primary(p,c.sessionId)===space.id)})) : [];
      const groups = [...spaceRows,...sources.filter(p=>p.kind!=='chat').map(p=>({id:p.id,name:p.name,rows:matching(p).filter(({p,c})=>!grouped||!primary(p,c.sessionId))}))].sort((a,b)=>a.name.localeCompare(b.name));
      groups.push({id:'chats',name:grouped?'Standalone Chat':'Chats',rows:sources.filter(p=>p.kind==='chat').flatMap(matching).filter(({p,c})=>!grouped||!primary(p,c.sessionId))});
      host.innerHTML = groups.filter(g => g.rows.length).map(group => `<section class="rc-reference-group" data-project="${esc(group.id)}"><h3>${esc(group.name)}<span>${group.rows.length}</span></h3>${group.rows.map(({p,c}) => {
        const added = references.some(r => r.projectId === p.id && r.sessionId === c.sessionId);
        const key=p.id+'::'+c.sessionId,chosen=selected.has(key);
        return `<button data-project-id="${esc(p.id)}" data-session-id="${esc(c.sessionId)}" aria-pressed="${chosen}" ${added ? 'disabled' : ''}>${icon('chat')}<strong>${esc(c.title || 'Untitled conversation')}</strong><span>${added ? 'Added' : chosen ? 'Selected' : 'Select'}</span></button>`;
      }).join('')}</section>`).join('') || '<p class="rc-chat-empty" role="status">No conversations match your search.</p>';
      host.querySelectorAll('button:not(:disabled)').forEach(button => button.onclick = async () => {
        const value={projectId:button.dataset.projectId,sessionId:button.dataset.sessionId},key=value.projectId+'::'+value.sessionId;
        if(selected.has(key))selected.delete(key);else selected.set(key,value);render();
      });
      d.querySelector('#rcReferenceSelection').textContent=selected.size?selected.size+' selected':'Select conversations to reference';
      d.querySelector('#rcReferenceAdd').disabled=!selected.size;
    }
    d.querySelector('#rcReferenceAdd').onclick=async()=>{const button=d.querySelector('#rcReferenceAdd');button.disabled=true;try{await request(base(id)+'/references',{references:[...(chat.references||[]),...selected.values()]});await engine.reloadProjects();d.close();tab='references';renderPanel();document.body.classList.add('rc-chat-panel-open');}catch(e){notify(e);button.disabled=false;}};
    d.querySelector('input').oninput = render; render();
  }
  function renderReferences() {
    const refs=current()?.references||[];
    $('rcChatPanelBody').innerHTML='<button id="rcChatAddReference">+ Add reference</button>'+refs.map((ref,i)=>{const p=engine.state().projects.find(p=>p.id===ref.projectId),c=p?.conversations?.find(c=>c.sessionId===ref.sessionId);return `<article class="rc-chat-reference" data-ref="${i}"><strong>${esc(c?.title||'Conversation unavailable')}</strong><small>${esc(p?.name||'')}</small><div><button data-read>Read</button><button data-message>Message</button><button data-remove>Remove</button></div></article>`;}).join('');
    $('rcChatAddReference').onclick=referencePicker;
    $('rcChatPanelBody').querySelectorAll('[data-ref]').forEach(row=>{const ref=refs[Number(row.dataset.ref)];row.querySelector('[data-read]').onclick=async()=>{try{const entries=await request(`/api/conversations/history?projectId=${encodeURIComponent(ref.projectId)}&sessionId=${encodeURIComponent(ref.sessionId)}&limit=30`);const d=dialog('Referenced conversation','<div class="rc-chat-reference-history"></div>');const host=d.querySelector('div');for(const entry of Array.isArray(entries)?entries:entries.rows||[]){const p=document.createElement('p');p.textContent=entry.role+': '+entry.text;host.append(p);}}catch(e){notify(e);}};
      row.querySelector('[data-message]').onclick=()=>{const d=dialog('Message project conversation','<form class="workspace-form"><textarea name="message" placeholder="Message" required></textarea><p>Chat will send this through the existing message approval and reply tools.</p><button class="cr-primary">Ask Chat to send</button></form>');d.querySelector('form').onsubmit=e=>{e.preventDefault();engine.insertPrompt(`Use send_message to send this message to projectId=${ref.projectId}, sessionId=${ref.sessionId}, then read the correlated reply:\n\n${e.target.elements.message.value}`);d.close();};};
      row.querySelector('[data-remove]').onclick=async()=>{try{await request(base(active)+'/references',{references:refs.filter(r=>r!==ref)});await engine.reloadProjects();renderReferences();}catch(e){notify(e);}};});
  }
  // ---- Owner view in every conversation but the Bot's (docs/owner-view-all-contract.md).
  // THE RULE (test/fixtures/owner-view-table.json; server/owner-view.ts is the server's copy). The chat is read in turns:
  // a turn starts at each NON-steered user row. It is an AGENT turn when that row's sender kind is conversation | mcp |
  // delegate | automation, unless the sender is this very conversation (data-sender-session = its own id: a message_self
  // continuation). Anything else (no sender, autopilot, recap, advisor, unknown) is the owner's.
  //   hidden by default: an agent turn's trigger, tools, notices and replies, unless the trigger carries
  //                      data-for-owner (history `forOwner`, or session_done {forOwner} / owner_view live);
  //   always shown ('keep'): error banners, the question card, an orphan card, an owner steer;
  //   an agent's steer (.msg.user.steered, agent sender) hides itself only inside an owner turn, and follows the
  //                      turn inside an agent turn;
  //   rows before the first user row (a page that starts mid-turn) use the server's data-owner-view.
  // Each run of consecutive hidden rows gets ONE real <button class="ov-btn"> before it. The button, the walker, the
  // #chat observer, loadHistory's dedupe and loadOlder all treat it as furniture, never as a row.
  const ov = { show: false, key: '', own: '' };
  const ovIsBtn = n => n.nodeType === 1 && n.classList.contains('ov-btn');
  const ovFurniture = n => n.nodeType !== 1 || ovIsBtn(n) || n.classList.contains('older-bar');
  function ovKind(row) {
    if (row.matches('.qcard,.orphan,.banner.err')) return 'keep';
    if (row.matches('.msg.user')) return !row.classList.contains('steered') ? 'trigger' : AGENT_SENDERS.includes(senderKindOf(row)) ? 'steer' : 'keep';
    return 'row';
  }
  function ovTurn(row) {
    const kind = senderKindOf(row), self = row.dataset.senderSession && row.dataset.senderSession === ov.own;
    return { lead: false, agent: AGENT_SENDERS.includes(kind) && !self, forOwner: row.dataset.forOwner === '1', ex: senderName(row) || 'an agent' };
  }
  const OV_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  function ovLabel(rows) {
    let n = 0; const names = new Set();
    for (const r of rows) {
      if (!r.matches('.msg')) continue;
      n++;
      if (r.matches('.msg.user')) { const name = senderName(r); if (name) names.add(name); }
    }
    const from = names.size === 1 ? [...names][0] : '';
    return { text: n ? `${n} hidden message${n === 1 ? '' : 's'}` : 'Hidden activity', from };
  }
  function ovPlace(run, stale) {
    if (!run.length) return;
    let btn = run[0].previousElementSibling; btn = btn && ovIsBtn(btn) ? btn : null;
    if (btn) stale.delete(btn);
    else { btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ov-btn'; btn.setAttribute('aria-expanded', 'false'); run[0].before(btn); }
    const { text, from } = ovLabel(run), key = text + '|' + from;
    if (btn._ovKey !== key) {
      btn._ovKey = key;
      btn.innerHTML = `${OV_ICON}<span class="ov-txt"></span>`;
      btn.lastChild.textContent = text + (from ? ' from ' + from : '');
      btn.setAttribute('aria-label', 'Show ' + text + (from ? ' from ' + from : ''));
    }
  }
  // Walk from `from` (the start of the run that holds the turn to re-walk) to the end. `rows` before `turn` are earlier
  // hidden rows of the same run: their state stands, they only join the run.
  function ovWalk(from, turn) {
    const stale = new Set(); let run = [], st = { lead: !turn, agent: false, forOwner: false, ex: '' }, earlier = !!turn;
    const close = () => { ovPlace(run, stale); run = []; };
    for (let row = from; row; row = row.nextElementSibling) {
      if (ovIsBtn(row)) { stale.add(row); continue; }
      if (row.classList.contains('older-bar')) continue;
      if (earlier) { if (row !== turn) { run.push(row); continue; } earlier = false; }
      const kind = ovKind(row);
      if (kind === 'trigger') st = ovTurn(row);
      let hide;
      if (kind === 'keep') hide = false;
      else if (st.lead) hide = row.dataset.ownerView === 'hide';
      else if (kind === 'steer') hide = !st.agent || !st.forOwner;
      else hide = st.agent && !st.forOwner;
      row.classList.toggle('ov-hidden', hide);
      const ex = !hide ? '' : st.lead ? 'an agent' : kind === 'steer' && !st.agent ? senderName(row) || 'an agent' : st.ex;
      row.classList.toggle('ov-agent-row', !!ex);
      const role = row.matches('.msg.assistant') ? row.querySelector(':scope>.role') : null;
      if (role) { if (ex) role.dataset.exchange = ex; else delete role.dataset.exchange; }
      if (hide) run.push(row); else close();
    }
    close();
    for (const b of stale) b.remove();
  }
  function ovSync(records) {
    const body = document.body, chat = $('chat'); if (!chat) return;
    if (body.classList.contains('rc-bot-chat')) {
      // The Bot has its own mode; a walk that ran before the Bot class was set leaves nothing behind.
      ov.key = ''; if (ov.show) ovSetShow(false);
      const stray = chat.querySelectorAll(':scope>.ov-btn,:scope>.ov-hidden,:scope>.ov-agent-row');
      stray.forEach(e => e.matches('.ov-btn') ? e.remove() : e.classList.remove('ov-hidden', 'ov-agent-row'));
      chat.querySelectorAll(':scope>.msg.assistant>.role[data-exchange]').forEach(r => { if (!r.parentElement.classList.contains('bot-agent-row')) delete r.dataset.exchange; });
      if (stray.length) ovObserver.takeRecords();
      return;
    }
    const st = engine.state(), key = st.projectId + '::' + st.sessionId;
    if (key !== ov.key) { ov.key = key; if (ov.show) ovSetShow(false); }
    ov.own = st.sessionId || '';
    let start = null;
    if (records) {
      for (const record of records) {
        if (record.target !== chat) continue;
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.every(ovFurniture)) continue;
        if (record.removedNodes.length || record.nextSibling) { start = undefined; break; }
        const added = [...record.addedNodes].find(n => !ovFurniture(n));
        if (added && added.parentNode === chat && (!start || start.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_PRECEDING)) start = added;
      }
      if (start === null) return;
    }
    const sc = chat.closest('.scroll'), atEnd = !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4;
    let turn = null, from;
    if (!start) from = chat.firstElementChild;
    else {
      turn = start.previousElementSibling;
      while (turn && !turn.matches('.msg.user:not(.steered)')) turn = turn.previousElementSibling;
      from = turn;
      // The run the turn continues starts earlier: step back over the hidden rows (and the button) just before it.
      if (turn) for (let p = turn.previousElementSibling; p && (ovIsBtn(p) || p.classList.contains('ov-hidden')); p = p.previousElementSibling) from = p;
      if (!turn) from = chat.firstElementChild;
    }
    ovWalk(from, turn);
    if (atEnd && sc) sc.scrollTop = sc.scrollHeight; // a button or revealed row must not leave a live thread off its bottom
    ovObserver.takeRecords();
  }
  function ovSetShow(on) {
    ov.show = !!on; document.body.classList.toggle('rc-ov-show', ov.show);
    const pill = $('rcOwnerPill'); if (pill) pill.hidden = !ov.show;
    document.querySelectorAll('#chat>.ov-btn').forEach(b => b.setAttribute('aria-expanded', String(ov.show)));
  }
  const ovObserver = new MutationObserver(records => ovSync(records));
  (function ovInit() {
    const chat = $('chat'); if (!chat) return;
    ovObserver.observe(chat, { childList: true });
    const pill = document.createElement('div'); pill.id = 'rcOwnerPill'; pill.hidden = true; pill.setAttribute('role', 'group'); pill.setAttribute('aria-label', 'Hidden messages');
    pill.innerHTML = '<span>Showing hidden messages</span><span aria-hidden="true">·</span><button type="button" id="rcOwnerHide">Hide</button>';
    // First child of the composer wrap: above the Chat toolbar row (mount() puts the pill back in front of it), never inside the composer.
    const wrap = document.querySelector('.composer-wrap');
    if (wrap) wrap.prepend(pill); else document.body.append(pill);
    chat.addEventListener('click', event => {
      const btn = event.target.closest('.ov-btn'); if (!btn || !chat.contains(btn)) return;
      // Keep what the reader was looking at where it is: the first revealed row takes the button's place.
      const sc = chat.closest('.scroll'), top = btn.getBoundingClientRect().top, anchor = btn.nextElementSibling;
      ovSetShow(true);
      if (sc && anchor) sc.scrollTop += anchor.getBoundingClientRect().top - top;
      $('rcOwnerHide').focus({ preventScroll: true });
    });
    $('rcOwnerHide').onclick = () => {
      ovSetShow(false);
      const sc = chat.closest('.scroll'), top = sc ? sc.getBoundingClientRect().top : 0;
      const btns = [...chat.querySelectorAll(':scope>.ov-btn')];
      const target = btns.find(b => b.getBoundingClientRect().bottom > top) || btns[btns.length - 1] || $('prompt');
      target?.focus({ preventScroll: true });
    };
    document.addEventListener('x056-history', () => ovSync());
    // Entering or leaving the Bot chat flips the mode without touching #chat: clean up or walk then.
    let wasBot = document.body.classList.contains('rc-bot-chat');
    new MutationObserver(() => { const now = document.body.classList.contains('rc-bot-chat'); if (now !== wasBot) { wasBot = now; ovSync(); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  })();
  document.addEventListener('x056:state', () => { const st = engine.state(), key = st.projectId + '::' + st.sessionId; if (key !== ov.key && !document.body.classList.contains('rc-bot-chat')) { ov.key = key; if (ov.show) ovSetShow(false); } });
  document.addEventListener('x056:state', syncBotFromRow);
  document.addEventListener('x056:state',sync);
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-chat-link]');
    if (!enabled || !link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(new URL(link.href).pathname);
  });
  window.addEventListener('popstate', () => { if (enabled) applyRoute(); });
  document.addEventListener('x056:reconnected',()=>{if(enabled)loadFiles();});
  document.addEventListener('x056:mode',event=>{if(event.detail.mode==='closed'){document.body.classList.remove('rc-chat-active','rc-chat-home-view');if(!routing&&inChat())window.history.pushState({},'', '/');}else setTimeout(sync,0);});
  document.addEventListener('x056:event',event=>{const {kind,data}=event.detail;if(kind==='bot_attention')applyBot({name:data.name,attention:data.needsMe!==undefined||data.fyi!==undefined?data:data.attention});if(kind==='chat_files'&&data.projectId===active)loadFiles();if(kind==='projects')engine.reloadProjects().then(sync);else if(kind==='conversation')setTimeout(sync,100);});
  return { ownerRefresh: () => ovSync(), navigate, leave, newChat, botAvatar: orb, botStatus, botName: () => botName, botBadge: botBadgeHTML, botRowVisibility, tools: toolsDialog, closePanel, refresh: renderChats, init:async()=>{try{const data=await request('/api/chats');enabled=data.enabled;if(enabled){mount();if(inChat()||inBot())await applyRoute();else sync();}else if(inBot())notify('Chat is turned off on this gateway, so the Bot is unavailable.');}catch(error){if(inChat()||inBot())notify(error);}}, upload, uploading:id=>[...jobs.values()].some(j=>j.chatId===id&&j.state==='uploading') };
};
