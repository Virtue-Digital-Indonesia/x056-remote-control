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
  main.querySelector('.topbar').insertAdjacentHTML('beforeend', `<button class="cr-secondary" id="chatActivity">${ic('sparkles')}<span>Activity</span><small id="chatActivityCount"></small></button>${iconButton('chatRefresh','refresh','Refresh conversation')}${iconButton('chatMax','expand','Maximize conversation')}${iconButton('chatClose','x','Close conversation')}`);
  const shell = document.createElement('section'); shell.id = 'controlRoom'; shell.setAttribute('aria-label', 'Control room');
  shell.innerHTML = `<header class="cr-top"><button class="cr-logo" id="crHome">x0<span>x056</span></button><nav aria-label="Main navigation"><button id="crBoardTab" aria-current="page">Control room</button><button id="crAccountsTab">Accounts</button></nav><span class="sp"></span><span id="crConnection" class="cr-connection">Connecting</span>${iconButton('crProjects','folder','Projects')}${iconButton('crTheme','moon','Change theme')}${iconButton('crSettings','gear','Display settings')}${iconButton('crNotifications','bell','Notifications')}</header>
  <div id="crBoard" class="cr-page"><div class="cr-heading"><div><div class="cr-eyebrow">CONVERSATIONS</div><h1 id="crScopeTitle">All projects</h1><p id="crScopeSubtitle">Conversations across your workspace</p></div><button class="cr-primary" id="crNew">${ic('plus')} New conversation</button></div><div id="crStats" class="cr-stats"></div><div class="cr-tools"><div class="cr-tabs" role="group" aria-label="Conversation filter"><button data-filter="all" class="selected">All conversations</button><button data-filter="question">Needs input</button><button data-filter="active">Running</button><button data-filter="unread">Unread</button></div><label class="cr-search">${ic('search')}<input id="crSearch" type="search" placeholder="Search conversations…" aria-label="Search conversations" /></label><select id="crProjectFilter" aria-label="Filter by project"><option value="">All projects</option></select></div><div id="crBoardError" role="status"></div><div class="cr-board" id="crLanes"></div></div>
  <div id="crAccounts" class="cr-page" hidden></div><div id="crAutomations" class="cr-page" hidden><div class="cr-heading"><div><h1>Automations</h1><p>Scheduled messages across your workspace.</p></div><button id="refreshAutomations" class="cr-secondary">Refresh</button></div><div id="automationContent"></div></div><div id="crToast" role="status" hidden></div>`;
  document.body.prepend(shell);
  const workspace = document.createElement('div'); workspace.id = 'crWorkspace';
  $('crBoard').before(workspace);
  workspace.innerHTML = `<nav id="crProjectNav" aria-label="Projects"><header><span>Projects</span>${iconButton('crAddProject','plus','Add project')}</header><label class="cr-project-search">${ic('search')}<input id="crProjectSearch" type="search" aria-label="Find a project" placeholder="Find a project" /></label><div id="crProjectLinks"></div><button id="crManageProjects" class="cr-project-manage">${ic('folder')} Manage projects</button></nav>`;
  workspace.append($('crBoard'), $('crAccounts'), $('crAutomations'));
  const primaryNav = shell.querySelector('.cr-top nav'); primaryNav.className = 'cr-primary-nav';
  $('crProjectNav').prepend(primaryNav);
  $('crBoardTab').innerHTML = ic('menu') + '<span>Control room</span>';
  $('crAccountsTab').innerHTML = ic('chart') + '<span>Dashboard</span>';
  primaryNav.insertAdjacentHTML('beforeend', '<button id="crAutomationsTab">'+ic('alarm')+'<span>Automations</span></button>');
  $('crProjectNav').insertAdjacentHTML('beforeend','<button id="sidebarSettings" class="cr-project-manage">'+ic('gear')+'Settings</button>');
  $('crHome').insertAdjacentHTML('afterend','<span id="crBreadcrumb">Workspace <span>/ Control room</span></span>');
  const projectVeil = document.createElement('div'); projectVeil.id='crProjectVeil'; projectVeil.hidden=true; shell.append(projectVeil);
  // Account selection stays next to the composer, in every presentation mode.
  content.querySelector('.composer').insertAdjacentHTML('beforeend', '<button id="sendAccountChip" class="send-account-chip" aria-haspopup="dialog"></button>');
  const sendAccounts = document.createElement('dialog'); sendAccounts.id='sendAccountPicker'; sendAccounts.className='cr-dialog';sendAccounts.setAttribute('aria-label','Choose an account'); document.body.append(sendAccounts);
  const veil = document.createElement('div'); veil.id = 'chatVeil'; veil.hidden = true; document.body.append(veil);
  const preferences = document.createElement('dialog'); preferences.id = 'displayPreferences'; preferences.className = 'cr-dialog'; preferences.setAttribute('aria-label','Settings');
  preferences.innerHTML = `<form method="dialog"><header><h2>Make yourself at home</h2><button class="cr-icon" aria-label="Close settings" value="close">${ic('x')}</button></header><p>Choose how conversations open on this device.</p><fieldset><legend>Open conversations in</legend><div class="cr-options"><label><input type="radio" name="open" value="side"><span>${ic('menu')}<strong>Side panel</strong><small>Keep the Control room in view</small></span></label><label><input type="radio" name="open" value="max"><span>${ic('expand')}<strong>Maximized</strong><small>Give the conversation more space</small></span></label></div></fieldset><fieldset><legend>When maximized</legend><div class="cr-options"><label><input type="radio" name="maximize" value="page"><span>${ic('expand')}<strong>Full page</strong><small>Fill the app with Focus mode</small></span></label><label><input type="radio" name="maximize" value="modal"><span>${ic('snippet')}<strong>Large modal</strong><small>A centered chat without a sidebar</small></span></label></div></fieldset><footer><small>Saved automatically on this device.</small><button class="cr-primary">Done</button></footer></form>`;
  document.body.append(preferences);
  let prefs = { open: 'side', maximize: 'page' };
  try { const saved = JSON.parse(localStorage.getItem('x056_display_preferences') || localStorage.getItem('x056_draft_chat_preferences_v1') || '{}'); if (['side','max','maximized'].includes(saved.open)) prefs.open = saved.open === 'maximized' ? 'max' : saved.open; if (['page','modal'].includes(saved.maximize)) prefs.maximize = saved.maximize; } catch {}
  const sectionScroll = {board:0,accounts:0,automations:0};
  let accountProvider = '', accountDays = '7', chartMetric = 'attempts', selectedSendAccount = '', pickerBusy = false;
  let recentLimit=10, selectedProject='', projectNavSignature='', sendAccountSignature='';
  try { selectedProject=localStorage.getItem('x056_project_scope') || ''; } catch {}
  let mode = 'closed', section = 'board', boardFilter = 'all', renderTimer, accountTimer, returnFocus;
  let boardSignature = '', accountSignature = '', analytics = null, routing = null, analyticsError = '', requestVersion = 0;
  const stage=document.createElement('div');stage.id='conversationStage';stage.setAttribute('aria-label','Quick conversation switcher');
  stage.innerHTML=`<div id="stageShelf" hidden><header><strong>Conversations</strong><small>Dismiss hides a shortcut</small></header><label class="stage-search">${ic('search')}<input id="stageSearch" type="search" placeholder="Find a conversation" aria-label="Find a quick conversation"></label><div id="stageItems"></div><button id="stageBrowse">Browse all conversations ${ic('right')}</button></div><button id="stageToggle" aria-label="Switch conversation" aria-expanded="false" aria-controls="stageShelf">${ic('chat')}<span id="stageCount"></span><i id="stageActive" hidden></i></button>`;
  document.body.append(stage);
  let stageRecent=[],stageDismissed=[],stageSignature='',stageCloseTimer,stagePinned=false;
  try{stageRecent=JSON.parse(localStorage.getItem('x056_stage_recent')||'[]');stageDismissed=JSON.parse(localStorage.getItem('x056_stage_dismissed')||'[]');if(!Array.isArray(stageRecent)||!Array.isArray(stageDismissed))throw Error();}catch{stageRecent=[];stageDismissed=[];}
  function saveStage(){try{localStorage.setItem('x056_stage_recent',JSON.stringify(stageRecent.slice(0,30)));localStorage.setItem('x056_stage_dismissed',JSON.stringify(stageDismissed.slice(-200)));}catch{}}
  function rememberStage(){const s=engine.state();if(!s.sessionId)return;const id=s.projectId+'::'+s.sessionId;stageRecent=[id,...stageRecent.filter(x=>x!==id)].slice(0,30);stageDismissed=stageDismissed.filter(x=>x!==id);saveStage();renderStage();}
  function stageOpen(value){clearTimeout(stageCloseTimer);$('stageShelf').hidden=!value;$('stageToggle').setAttribute('aria-expanded',String(value));if(value)renderStage();}
  $('stageToggle').onclick=()=>{stagePinned=!stagePinned;stageOpen(stagePinned);};
  stage.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){clearTimeout(stageCloseTimer);stageOpen(true);}});
  stage.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'&&!stagePinned&&!stage.contains(document.activeElement))stageCloseTimer=setTimeout(()=>stageOpen(false),250);});
  stage.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('stageShelf').hidden){e.preventDefault();e.stopPropagation();stagePinned=false;stageOpen(false);$('stageToggle').focus();}});
  document.addEventListener('pointerdown',e=>{if(!stage.contains(e.target)){stagePinned=false;stageOpen(false);}});
  $('stageSearch').oninput=()=>renderStage();
  $('stageBrowse').onclick=()=>{stagePinned=false;stageOpen(false);showSection('board');$('crSearch').focus();};
  function renderStage(){
    const all=cards(),s=engine.state(),query=$('stageSearch').value.trim().toLowerCase();
    const id=x=>x.p.id+'::'+x.c.sessionId;
    const eligible=all.filter(x=>!stageDismissed.includes(id(x))&&(stageRecent.includes(id(x))||['running','background','question'].includes(x.status)||x.c.sessionId===s.sessionId));
    eligible.sort((a,b)=>{const ai=stageRecent.indexOf(id(a)),bi=stageRecent.indexOf(id(b));return (ai<0?100:ai)-(bi<0?100:bi)||b.time-a.time;});
    const rows=(query?all.filter(x=>[x.p.name,x.c.title].join(' ').toLowerCase().includes(query)):eligible).slice(0,30);
    $('stageCount').textContent=eligible.length||'';$('stageCount').hidden=!eligible.length;
    $('stageActive').hidden=!all.some(x=>['running','background'].includes(x.status));
    const html=rows.map(x=>`<div class="stage-item ${x.c.sessionId===s.sessionId&&x.p.id===s.projectId?'current':''}"><button class="stage-conversation" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}"><span class="stage-caption"><strong>${esc(x.c.title||'Conversation')}</strong><small>${esc(x.p.name)} · ${statusLabels[x.status]||'Recent'}</small></span><span class="stage-orb ${x.status}" style="--project-color:${projectColor(x.p.id)}">${ic(x.status==='running'?'sparkles':'chat')}</span></button><button class="stage-dismiss" data-stage-dismiss="${esc(id(x))}" aria-label="Dismiss ${esc(x.c.title||'conversation')} shortcut">${ic('x')}</button></div>`).join('')||'<p class="stage-empty">Open a conversation to keep it here.</p>';
    if(html===stageSignature)return;stageSignature=html;const focus=document.activeElement?.dataset.session;$('stageItems').innerHTML=html;
    $('stageItems').querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>{stagePinned=false;stageOpen(false);openConversation(b);});
    $('stageItems').querySelectorAll('[data-stage-dismiss]').forEach(b=>b.onclick=()=>{stageDismissed.push(b.dataset.stageDismiss);stageRecent=stageRecent.filter(x=>x!==b.dataset.stageDismiss);saveStage();renderStage();$('stageToggle').focus();});
    if(focus)[...$('stageItems').querySelectorAll('[data-session]')].find(b=>b.dataset.session===focus)?.focus({preventScroll:true});
  }
  // Native cancel handlers also settle confirmation promises and clean up utilities.
  let outsideDialog=null;
  function outsideBounds(dialog,event){const r=dialog.getBoundingClientRect();return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;}
  document.addEventListener('pointerdown',e=>{outsideDialog=e.target instanceof HTMLDialogElement&&e.target.open&&outsideBounds(e.target,e)?e.target:null;},true);
  document.addEventListener('click',e=>{
    const dialog=outsideDialog;outsideDialog=null;
    if(dialog&&e.target===dialog&&dialog.open&&outsideBounds(dialog,e)){
      const event=new Event('cancel',{cancelable:true});if(dialog.dispatchEvent(event))dialog.close();
    }
  },true);
  const outcomes = new Map();
  const positions = new Map();
  const compact = n => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const totalTokens = r => r.input + r.output + r.cached + r.cacheWrite;
  const toastElement=$('crToast');
  function toast(message) { const dialogs=[...document.querySelectorAll('dialog[open]')];(dialogs[dialogs.length-1]||shell).append(toastElement);toastElement.textContent=message;toastElement.hidden=false;clearTimeout(accountTimer);accountTimer=setTimeout(()=>toastElement.hidden=true,6000); }
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
    (mode==='closed'?document.body:main).append(stage);
  }
  function open() { rememberStage(); if (mode === 'closed') { returnFocus = document.activeElement; setMode(prefs.open === 'side' ? 'side' : prefs.maximize); requestAnimationFrame(() => $('chatClose').focus()); } updateTitle(); }
  function close() { engine.closePops(); engine.nav(false); setMode('closed'); if (returnFocus?.isConnected) returnFocus.focus(); else $('crBoardTab').focus(); }
  function pageFor(name) { return $(name==='board'?'crBoard':name==='accounts'?'crAccounts':'crAutomations'); }
  function showSection(next) {
    sectionScroll[section] = pageFor(section).scrollTop;
    close(); engine.nav(false); section = next; projectNav(false);
    ['board','accounts','automations'].forEach(name=>pageFor(name).hidden=name!==next);
    ['Board','Accounts','Automations'].forEach(name=>$('cr'+name+'Tab').setAttribute('aria-current',next===name.toLowerCase()?'page':'false'));
    $('crBreadcrumb').innerHTML='Workspace <span>/ '+({board:'Control room',accounts:'Dashboard',automations:'Automations'}[next])+'</span>';
    if(next==='accounts') { renderAccountsPage(); renderProjectCosts(); loadProjectCosts(); loadAnalytics(); engine.pollAccounts(); }
    else if(next==='automations') $('cronBtn').click();
    else refresh();
    pageFor(next).scrollTop=sectionScroll[next];
  }
  function settings(tab='general') { engine.closePops(); settingsTab(tab); if(!preferences.open) preferences.showModal(); }
  preferences.addEventListener('change', e => { if (!['open','maximize'].includes(e.target.name)) return; prefs[e.target.name] = e.target.value; try { localStorage.setItem('x056_display_preferences', JSON.stringify(prefs)); } catch { toast('This browser could not save display settings.'); } if (['page','modal'].includes(mode)) setMode(prefs.maximize); });
  const on = (id, fn) => $(id).addEventListener('click', fn);
  ['crSettings','sidebarSettings','focusSettings'].forEach(id => on(id, () => settings()));
  on('crTheme', e=>themeMenu(e.currentTarget));
  ['crAccountsTab','focusAccounts'].forEach(id => on(id, () => showSection('accounts')));
  ['crHome','crBoardTab','focusHome','focusBack'].forEach(id => on(id, () => showSection('board')));
  on('crProjects', () => projectNav(!shell.classList.contains('projects-open')));
  on('crAddProject',()=>{projectNav(false);$('addProjectBtn').click();});
  on('crManageProjects',()=>{projectNav(false);engine.nav(true);});
  $('crProjectSearch').addEventListener('input',()=>renderProjectNav(cards(),engine.state()));
  projectVeil.addEventListener('click',()=>projectNav(false));
  on('sendAccountChip',()=>{selectedSendAccount='';renderSendAccounts(true);sendAccounts.showModal();});
  on('crAutomationsTab',()=>showSection('automations')); on('refreshAutomations',()=> $('cronBtn').click()); on('crNotifications',e=>notificationMenu(e.currentTarget)); on('chatActivity',e=>activityMenu(e.currentTarget)); on('focusSearch', () => $('searchChatsBtn').click());
  ['crNew','focusNew'].forEach(id => on(id, () => { engine.newConversation(selectedProject); open(); }));
  on('chatRefresh', async e => {
    const button=e.currentTarget;button.disabled=true;button.setAttribute('aria-busy','true');rememberPosition();
    try {await engine.refreshConversation();restorePosition();refresh();toast('Conversation refreshed.');}
    catch(err){toast('Could not refresh. '+err.message);}
    finally{button.disabled=false;button.removeAttribute('aria-busy');}
  });
  on('chatClose', close); on('chatMax', () => setMode(mode === 'side' ? prefs.maximize : 'side'));
  veil.addEventListener('click', close);
  $('acctChip').addEventListener('click', e => { e.stopImmediatePropagation(); engine.closePops(); showSection('accounts'); }, true);
  $('crSearch').addEventListener('input', () => {recentLimit=10;renderBoard();});
  $('crProjectFilter').addEventListener('change', () => selectProjectScope($('crProjectFilter').value));
  shell.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { recentLimit=10;boardFilter = b.dataset.filter; shell.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('selected', x === b)); renderBoard(); }));
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || document.querySelector('dialog[open],.ui-veil,.palette-veil') || !document.querySelector('#backdrop').hidden || document.body.classList.contains('nav-open')) return;
    if (e.key === 'Escape' && shell.classList.contains('projects-open')) { e.preventDefault();projectNav(false);$('crProjects').focus();return; }
    if (e.key === 'Tab' && shell.classList.contains('projects-open') && innerWidth<=850) {
      const nodes=[$('crProjects'),...$('crProjectNav').querySelectorAll('button,input')].filter(n=>!n.disabled),first=nodes[0],last=nodes[nodes.length-1];
      if(e.shiftKey&&(document.activeElement===first||!nodes.includes(document.activeElement))){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&(document.activeElement===last||!nodes.includes(document.activeElement))){e.preventDefault();first.focus();}
    }
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
  const projectColors = ['#6d77d5','#3a9a82','#bd8260','#9d70bf','#ba6583','#648cae','#a29249','#6195a0'];
  function projectColor(id) { let h=0;for(const c of id) h=(h*31+c.charCodeAt(0))>>>0;return projectColors[h%projectColors.length]; }
  function projectNav(open) {
    const narrow=innerWidth<=850;
    pageFor(section).inert=open&&narrow;
    $('crProjectNav').inert=!open&&narrow;
    $('crProjects').setAttribute('aria-expanded',String(open||!narrow));
    shell.classList.toggle('projects-open',open);projectVeil.hidden=!open||!narrow;
    if(open) $('crProjectSearch').focus();
  }
  window.addEventListener('resize',()=>projectNav(false));
  function selectProjectScope(id) {
    if(section!=='board') showSection('board');
    selectedProject=id;recentLimit=10;try{localStorage.setItem('x056_project_scope',id);}catch{}
    projectNav(false);$('crBoard').scrollTop=0;renderBoard();
    $('crScopeTitle').tabIndex=-1;$('crScopeTitle').focus({preventScroll:true});
  }
  function renderProjectNav(all,state) {
    document.querySelectorAll('#projectList .proj[data-id]').forEach(row=>row.style.setProperty('--project-color',projectColor(row.dataset.id)));
    const query=$('crProjectSearch').value.toLowerCase();
    const html=`<button class="cr-project-link ${!selectedProject?'selected':''}" data-scope="" aria-current="${!selectedProject?'page':'false'}">${ic('menu')}<span>All projects</span><small>${all.length}</small></button><div class="cr-project-separator"></div>`+state.projects.filter(p=>p.name.toLowerCase().includes(query)).map(p=>{
      const rows=all.filter(x=>x.p.id===p.id), attention=rows.filter(x=>['question','failed','parked'].includes(x.status)).length, running=rows.filter(x=>['running','background'].includes(x.status)).length;
      return `<button class="cr-project-link ${p.id===selectedProject?'selected':''}" data-scope="${esc(p.id)}" aria-current="${p.id===selectedProject?'page':'false'}" title="${esc(p.name)}"><i class="cr-project-color" style="--project-color:${projectColor(p.id)}"></i><span>${esc(p.name)}</span>${attention?`<small class="attention" title="${attention} need attention">${attention}</small>`:running?`<small class="working" title="${running} running">${running}</small>`:`<small>${rows.length}</small>`}</button>`;
    }).join('');
    if(html!==projectNavSignature){projectNavSignature=html;$('crProjectLinks').innerHTML=html;$('crProjectLinks').querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>selectProjectScope(b.dataset.scope));}
  }
  function relativeDate(value) { const d=new Date(value), elapsed=Date.now()-d.getTime();if(isNaN(d))return '';if(elapsed<60000)return 'Just now';if(elapsed<3600000)return Math.floor(elapsed/60000)+'m ago';if(elapsed<86400000)return Math.floor(elapsed/3600000)+'h ago';return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
  async function openConversation(button) {
    button.disabled=true;
    try {rememberPosition();await engine.select(button.dataset.project,button.dataset.session);engine.markRead();open();restorePosition();renderSendAccounts();}
    catch(e){toast(e.message);}finally{if(button.isConnected)button.disabled=false;}
  }
  function conversationRow(x) {
    return `<article class="cr-conversation-row ${x.status}" data-row="${esc(x.c.sessionId)}"><button class="cr-task" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}"><i class="cr-project-color" style="--project-color:${projectColor(x.p.id)}"></i><span class="cr-row-copy"><span class="cr-row-title">${esc(x.c.title||'Conversation')}${x.unread?'<i class="cr-unread-dot" title="Unread"></i>':''}</span><span class="cr-row-subtitle">${esc(selectedProject ? (x.label || (x.c.provider==='codex'?'ChatGPT':'Claude')) : x.p.name+(x.label?' · '+x.label:''))}</span></span><span class="cr-status ${x.status}"><i></i>${statusLabels[x.status]}</span><time>${esc(relativeDate(x.time))}</time></button>${x.status==='question'?`<button class="cr-dismiss" data-dismiss="${esc(x.c.sessionId)}" data-project="${esc(x.p.id)}" title="Dismiss question without sending a reply">Dismiss question</button>`:''}</article>`;
  }
  function renderBoard() {
    const all=cards(),state=engine.state();
    if(selectedProject&&!state.projects.some(p=>p.id===selectedProject)&&state.projects.length)selectedProject='';
    const scope=all.filter(x=>!selectedProject||x.p.id===selectedProject),project=state.projects.find(p=>p.id===selectedProject);
    $('crScopeTitle').textContent=project?.name||'All projects';
    $('crScopeSubtitle').textContent=scope.length+' conversations'+(project?'':' across '+state.projects.length+' projects');
    $('crStats').innerHTML=[[scope.filter(x=>['running','background'].includes(x.status)).length,'Running'],[scope.filter(x=>x.status==='question').length,'Needs input'],[scope.filter(x=>x.unread).length,'Unread']].map(([n,t])=>`<div><strong>${n}</strong><span>${t}</span></div>`).join('');
    renderProjectNav(all,state);
    const selector=$('crProjectFilter');selector.innerHTML='<option value="">All projects</option>'+state.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');selector.value=selectedProject;
    const query=$('crSearch').value.toLowerCase();
    const filtered=scope.filter(x=>(!query||(x.c.title+' '+x.p.name+' '+x.label).toLowerCase().includes(query))&&(boardFilter==='all'||boardFilter==='question'&&x.status==='question'||boardFilter==='unread'&&x.unread||boardFilter==='active'&&['running','background'].includes(x.status)));
    const attention=filtered.filter(x=>['question','failed','parked'].includes(x.status)),active=filtered.filter(x=>['running','background'].includes(x.status)),recent=filtered.filter(x=>['finished','idle'].includes(x.status));
    const groups=[['Needs attention',attention],['In progress',active],['Recent conversations',recent.slice(0,recentLimit)]];
    let html=groups.filter(([,rows])=>rows.length).map(([title,rows])=>`<section class="cr-conversation-group"><header><h2>${title}</h2><span>${title==='Recent conversations'?recent.length:rows.length}</span></header>${rows.map(conversationRow).join('')}</section>`).join('');
    if(!html)html=`<div class="cr-empty">${query?'No conversations match your search.':boardFilter==='question'?'No questions need your input.':'No conversations in this view.'}</div>`;
    if(recent.length>recentLimit)html+=`<button class="cr-load-more" id="crShowMore">Show ${Math.min(20,recent.length-recentLimit)} more conversations <span>${recent.length-recentLimit} remaining</span></button>`;
    if(html!==boardSignature){
      boardSignature=html;
      const focused=document.activeElement?.closest('.cr-conversation-row')?.dataset.row,moreFocused=document.activeElement?.id==='crShowMore';
      $('crLanes').innerHTML=html;
      if(focused)([...$('crLanes').querySelectorAll('.cr-task')].find(n=>n.dataset.session===focused)||shell.querySelector('[data-filter="question"]')).focus({preventScroll:true});
      if(moreFocused)($('crShowMore')||$('crLanes').querySelector('.cr-task:last-child'))?.focus({preventScroll:true});
      $('crLanes').querySelectorAll('.cr-task').forEach(b=>b.onclick=()=>openConversation(b));
      $('crLanes').querySelectorAll('[data-dismiss]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await engine.dismissQuestion(b.dataset.project,b.dataset.dismiss);toast('Question dismissed. No reply sent.');refresh();}catch(e){toast(e.message);b.disabled=false;}});
      if($('crShowMore'))$('crShowMore').onclick=()=>{recentLimit+=20;renderBoard();};
    }
    updateTitle();renderSendAccounts();if(section==='accounts'){renderProjectCosts();loadProjectCosts();}renderRuns();renderStage();
  }
  let costSnapshot=null,costError='',costBusy=false,costUpdated=0,costSignature='';
  const costDialog=document.createElement('dialog');costDialog.className='cr-dialog';costDialog.id='projectCostDetails';costDialog.setAttribute('aria-label','Project cost estimates');document.body.append(costDialog);
  const money=n=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n||0);
  function costRows(){return costSnapshot?.projects||[];}
  function renderProjectCosts(){
    if(!$('crProjectCosts'))return;
    const rows=costRows(),usd=rows.reduce((n,p)=>n+p.cost.usd,0),tokens=rows.reduce((n,p)=>n+p.usage.input+p.usage.output+p.usage.cacheRead+p.usage.cacheWrite,0);
    const partial=rows.some(p=>p.partial),unknown=[...new Set(rows.flatMap(p=>p.cost.unpriced))],missing=rows.reduce((n,p)=>n+p.missing,0);
    const markup=`<div><span class="cr-eyebrow">PROJECT COST ESTIMATE</span><div class="cr-cost-value">${costSnapshot?'≈ '+money(usd):'—'}<small>${costSnapshot?compact(tokens)+' recorded tokens':'Loading recorded usage…'}</small></div><p>${costError?esc(costError):partial?'Scanning transcripts · totals are still updating':unknown.length?'Some models are unpriced':missing?'Some conversations have no recorded usage':'At standard API rates · includes subagents'}</p></div><button class="cr-secondary" id="crCostDetails">${costError?'Retry':'View breakdown'} ${ic('right')}</button>`;
    if(markup===costSignature)return;costSignature=markup;$('crProjectCosts').innerHTML=markup;
    $('crCostDetails').onclick=()=>{if(costError){loadProjectCosts(true);return;}renderCostDetails();costDialog.showModal();};
  }
  function renderCostDetails(){
    const rows=costRows(),max=Math.max(0.01,...rows.map(p=>p.cost.usd));
    const scrollTop=costDialog.querySelector('.cost-breakdown')?.scrollTop||0, expanded=new Set([...costDialog.querySelectorAll('details[open]')].map(d=>d.dataset.project));
    costDialog.innerHTML=`<header><div><h2>Project cost estimates</h2><p>All projects · Recorded usage</p></div><button class="cr-icon" data-cost-close aria-label="Close cost breakdown">${ic('x')}</button></header><div class="cost-breakdown">${rows.map(p=>`<details class="cost-project" data-project="${esc(p.projectId)}" ${expanded.has(p.projectId)?'open':''}><summary><span><strong>${esc(p.projectName)}</strong><small>${p.conversations} conversations · ${p.agentCount} agents${p.partial?' · Updating':''}${p.missing?' · Missing transcripts':''}</small></span><strong>≈ ${money(p.cost.usd)}</strong></summary><div class="cost-bar" role="img" aria-label="${esc(p.projectName)}: ${money(p.cost.usd)}"><i style="width:${p.cost.usd/max*100}%"></i></div><p class="cost-agent-note">Includes ${money(p.agentUsd)} from subagents${p.cost.unpriced.length?' · Unpriced: '+esc(p.cost.unpriced.join(', ')):''}</p><div class="cost-conversations">${(costSnapshot?.conversations||[]).filter(c=>c.projectId===p.projectId).sort((a,b)=>b.cost.usd-a.cost.usd).map(c=>`<div><span>${esc(c.title)}<small>${compact(c.usage.input+c.usage.output+c.usage.cacheRead+c.usage.cacheWrite)} tokens${c.partial?' · Scanning':''}${c.missing?' · No transcript':''}${c.cost.unpriced.length?' · Unpriced usage':''}</small></span><strong>${c.missing&&!c.size?'—':'≈ '+money(c.cost.usd)}</strong></div>`).join('')}</div></details>`).join('')||'<p class="cr-empty">No project usage recorded yet.</p>'}</div><footer class="cost-footer"><p>${esc(costSnapshot?.pricing?.basis||'Estimates use recorded tokens at standard API rates.')}<br>Rates checked ${esc(costSnapshot?.pricing?.date||'—')}. <a href="https://developers.openai.com/api/docs/models" target="_blank" rel="noopener">OpenAI rates</a> · <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noopener">Claude rates</a></p><button class="cr-secondary" data-cost-refresh ${costBusy?'disabled':''}>Refresh</button></footer>`;
    costDialog.querySelector('.cost-breakdown').scrollTop=scrollTop;
    costDialog.querySelector('[data-cost-close]').onclick=()=>costDialog.close();
    costDialog.querySelector('[data-cost-refresh]').onclick=()=>loadProjectCosts(true);
  }
  async function loadProjectCosts(force=false){
    if(costBusy||(!force&&Date.now()-costUpdated<30000))return;costBusy=true;
    try{costSnapshot=await json('/api/usage/all?budgetMs=250');costError='';costUpdated=Date.now();}
    catch(e){costError='Could not load cost estimates. '+e.message;costUpdated=Date.now();}
    finally{costBusy=false;renderProjectCosts();if(costDialog.open)renderCostDetails();}
    if(costSnapshot?.pendingBytes&&!costError)setTimeout(()=>{if(!document.hidden&&(section==='accounts'||costDialog.open))loadProjectCosts(true);},3000);
  }
  setInterval(()=>{if(!document.hidden&&section==='board')loadProjectCosts();},30000);
  const runningDialog=document.createElement('dialog');runningDialog.id='runningConversations';runningDialog.className='cr-dialog';runningDialog.setAttribute('aria-label','Running conversations');
  runningDialog.innerHTML=`<header><div><h2>Running conversations</h2><p id="runningSummary"></p></div><button class="cr-icon" data-running-close aria-label="Close running conversations">${ic('x')}</button></header><label class="cr-search">${ic('search')}<input id="runningSearch" type="search" placeholder="Find a conversation or project" aria-label="Find running conversation"></label><div id="runningGroups"></div>`;document.body.append(runningDialog);
  runningDialog.querySelector('[data-running-close]').onclick=()=>runningDialog.close();$('runningSearch').oninput=()=>renderRunningList();
  let runningSignature='',runningListSignature='';
  function runningRows(){const s=engine.state();return cards().filter(x=>(s.running[x.p.id]?.[x.c.sessionId]||s.background[x.p.id]?.[x.c.sessionId])&&!(x.p.id===s.projectId&&x.c.sessionId===s.sessionId)).map(x=>({...x,status:s.running[x.p.id]?.[x.c.sessionId]?'running':'background'}));}
  function activitySummary(label){if(!label)return 'Working';if(/^(Running:|Bash|Shell)/i.test(label))return 'Running a command';if(/edit|patch|writing/i.test(label))return 'Editing files';if(/search/i.test(label))return 'Searching';if(/agent|delegat/i.test(label))return 'Working with agents';if(/read|view/i.test(label))return 'Reading';return 'Working';}
  function renderRuns(){
    const rows=runningRows(),projects=new Set(rows.map(x=>x.p.id)),background=rows.filter(x=>x.status==='background').length;
    const html=rows.length?`<button id="runningSummaryButton" class="running-summary-button" aria-haspopup="dialog"><span class="running-indicator"></span><strong>${rows.length} other ${rows.length===1?'conversation':'conversations'} running</strong><span>${projects.size} ${projects.size===1?'project':'projects'}</span>${ic('up')}</button>`:'';
    if(html!==runningSignature){runningSignature=html;$('otherRuns').innerHTML=html;if($('runningSummaryButton'))$('runningSummaryButton').onclick=()=>{renderRunningList();runningDialog.showModal();};}
    if(runningDialog.open)renderRunningList();
    renderStage();
  }
  function renderRunningList(){
    const all=runningRows(),q=$('runningSearch').value.trim().toLowerCase(),rows=all.filter(x=>[x.p.name,x.c.title].join(' ').toLowerCase().includes(q));
    $('runningSummary').textContent=all.length+' conversations across '+new Set(all.map(x=>x.p.id)).size+' projects';
    const groups=new Map();for(const x of rows){if(!groups.has(x.p.id))groups.set(x.p.id,{project:x.p,rows:[]});groups.get(x.p.id).rows.push(x);}
    const html=[...groups.values()].map(g=>`<section class="running-group"><header><i class="cr-project-color" style="--project-color:${projectColor(g.project.id)}"></i><h3>${esc(g.project.name)}</h3><small>${g.rows.length}</small></header>${g.rows.map(x=>`<button class="running-conversation" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}"><span><strong>${esc(x.c.title||'Conversation')}</strong><small>${x.status==='background'?'Background work':activitySummary(x.label)}</small></span><span class="agent-status ${x.status}">${x.status==='background'?'Background':'Running'}</span>${ic('right')}</button>`).join('')}</section>`).join('')||'<div class="agent-empty">'+(all.length?'No matching conversations.':'No other conversations are running.')+'</div>';
    if(html===runningListSignature)return;runningListSignature=html;const focus=document.activeElement?.dataset.session;$('runningGroups').innerHTML=html;
    $('runningGroups').querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>{runningDialog.close();openConversation(b);});
    if(focus)[...$('runningGroups').querySelectorAll('[data-session]')].find(b=>b.dataset.session===focus)?.focus({preventScroll:true});
  }
  function accountName(a) { return a ? a.label || (a.displayName !== a.name && a.displayName) || a.email || (a.provider==='codex'?'ChatGPT account':'Claude account') : 'Checking account…'; }
  function providerName(p) { return p==='codex'?'ChatGPT':'Claude'; }
  function accountStatus(a) { return a.paused?'Paused':a.state?.kind==='limited'?'Limited':a.state?.kind==='unauthenticated'?'Needs login':a.state?.kind==='ok'?'Available':'Not checked'; }
  function identity(a) { return `<span class="cr-account-avatar ${esc(a.provider)}">${a.provider==='codex'?'G':'C'}</span><span class="identity-copy"><strong>${esc(accountName(a))}</strong><small>${esc(a.email || providerName(a.provider))}</small></span>`; }
  function renderSendAccounts(force=false) {
    const s=engine.state(), pool=s.accounts.filter(a=>a.provider===s.provider), next=pool.find(a=>a.nextUp);
    const isRunning=!!s.running[s.projectId]?.[s.sessionId], running=pool.find(a=>a.name===s.runningAccount);
    const chip=ic('user')+`<span>${isRunning?'Next message':'Send with'} <strong>${esc(next?accountName(next):'No available account')}</strong></span><small>${esc(next?.email || providerName(s.provider))}</small>`+ic('down');
    if($('sendAccountChip').innerHTML!==chip) $('sendAccountChip').innerHTML=chip;
    $('sendAccountChip').title='Choose the account for the next message';
    $('runningAccountLabel').hidden=!isRunning;
    $('runningAccountLabel').textContent=isRunning?'Working with '+accountName(running)+' · '+providerName(s.provider):'';
    if((!sendAccounts.open&&!force)||pickerBusy)return;
    if(!pool.some(a=>a.name===selectedSendAccount&&available(a))) selectedSendAccount=next?.name||pool.find(available)?.name||'';
    const html=`<header><h2>Choose an account</h2><button class="cr-icon" data-close aria-label="Close account picker">${ic('x')}</button></header>
      <p>${providerName(s.provider)} · Choose the account for your next message.</p>
      ${isRunning?`<div class="picker-running">${ic('repeat')}<span>Running with <strong>${esc(accountName(running))}</strong></span></div>`:''}
      <div class="send-account-list" role="radiogroup" aria-label="${providerName(s.provider)} accounts">${pool.map(a=>`<label class="account-pick-card ${a.name===selectedSendAccount?'selected':''} ${available(a)?'':'unavailable'}">
        <div class="picker-account-head"><span class="cr-identity">${identity(a)}</span><input type="radio" name="send-account" value="${esc(a.name)}" ${a.name===selectedSendAccount?'checked':''} ${available(a)?'':'disabled'} aria-label="${esc(accountName(a))}"></div>
        <div class="picker-status">${esc(accountStatus(a))}${a.nextUp?' · Next message':''}${isRunning&&a.name===s.runningAccount?' · Running this turn':''}</div>
        <div class="picker-quotas">${quotaCell(a,quotaWindows(a).five,'5-hour window')}${quotaCell(a,quotaWindows(a).seven,'7-day window')}</div>
        ${quotaWindows(a).other.length?`<details class="picker-extra"><summary>${quotaWindows(a).other.length} additional usage ${quotaWindows(a).other.length===1?'limit':'limits'}</summary><div class="picker-quotas">${quotaWindows(a).other.map(w=>quotaCell(a,w,w.label)).join('')}</div></details>`:''}
        ${quotaFreshness(a)}</label>`).join('')||'<div class="cr-empty">No accounts connected for this provider.</div>'}</div>
      <p class="picker-note">This choice overrides routing for the next ${providerName(s.provider)} attempt. ${isRunning?'Use “Switch this turn” to resume the current turn on another account.':''}</p>
      <div id="pickerError" class="cr-error" role="alert"></div><footer><button class="cr-text-button" data-manage-accounts>Manage accounts</button><span class="sp"></span>${isRunning?`<button class="cr-secondary" data-switch-turn ${!selectedSendAccount||selectedSendAccount===s.runningAccount?'disabled':''}>Switch this turn</button>`:''}<button class="cr-primary" data-send-next ${selectedSendAccount?'':'disabled'}>Use for next message</button></footer>`;
    if(html===sendAccountSignature&&!force)return;
    sendAccountSignature=html;
    const focused=document.activeElement, focusValue=focused?.name==='send-account'?focused.value:null, oldScroll=sendAccounts.querySelector('.send-account-list')?.scrollTop||0;
    sendAccounts.innerHTML=html;
    sendAccounts.querySelector('.send-account-list').scrollTop=oldScroll;
    if(focusValue) [...sendAccounts.querySelectorAll('input')].find(n=>n.value===focusValue)?.focus({preventScroll:true});
    sendAccounts.querySelector('[data-close]').onclick=()=>sendAccounts.close();
    sendAccounts.querySelector('[data-manage-accounts]').onclick=()=>{sendAccounts.close();showSection('accounts');};
    sendAccounts.querySelectorAll('[name="send-account"]').forEach(input=>input.onchange=()=>{selectedSendAccount=input.value;renderSendAccounts(true);});
    const choose=async(switching)=>{
      // Recheck current state: this dialog may have stayed open across a completed turn.
      const state=engine.state(), selected=state.accounts.find(a=>a.name===selectedSendAccount&&a.provider===s.provider);
      if(!selected||!available(selected)||state.provider!==s.provider) { renderSendAccounts(true);return; }
      let failure='';pickerBusy=true; sendAccounts.querySelectorAll('button,input').forEach(b=>b.disabled=true);
      try {
        await json(switching?'/api/switch':'/api/accounts/active',switching?{projectId:s.projectId,sessionId:s.sessionId,account:selected.name}:{name:selected.name});
        await engine.pollAccounts(); sendAccounts.close(); toast(switching?'Switching this turn to '+accountName(selected)+'…':'Next message will use '+accountName(selected)+'.');
      } catch(e) { failure=e.message; }
      finally {pickerBusy=false;renderSendAccounts(true);if(failure)$('pickerError').textContent=failure;}
    };
    sendAccounts.querySelector('[data-send-next]').onclick=()=>choose(false);
    const switchButton=sendAccounts.querySelector('[data-switch-turn]');if(switchButton)switchButton.onclick=()=>choose(true);
  }
  function refresh() { clearTimeout(renderTimer); renderTimer = setTimeout(() => { renderBoard(); if (section === 'accounts') renderAccountRows(); }, 60); }
  async function json(url, body) { const res = await engine.api(url, body === undefined ? undefined : { method:'POST', body:JSON.stringify(body) }); const data = await res.json(); if (!res.ok) throw new Error(data.message || 'Request failed'); return data; }
  function event(kind, data) {
    if (['session_done','session_error','turn_orphaned'].includes(kind)) outcomes.set(data.projectId + '::' + data.sessionId, { status:kind === 'session_done' ? data.status : 'failed', reason:data.reason || data.message, ts:data.ts || Date.now() });
    if (kind === 'session_started') outcomes.delete(data.projectId + '::' + data.sessionId);
    refresh();
    if (section === 'accounts' && ['session_done','accounts'].includes(kind)) loadAnalytics();
  }
  function segmented(id, items, value, label) {
    return `<div id="${id}" class="cr-segments" role="group" aria-label="${label}">${items.map(([v,t])=>`<button data-value="${v}" aria-pressed="${v===value}">${t}</button>`).join('')}</div>`;
  }
  function wireSegment(id, change) { $(id).querySelectorAll('button').forEach(b=>b.onclick=()=>{ $(id).querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));change(b.dataset.value); }); }
  function renderAccountsPage() {
    if ($('accountProvider')) return;
    $('crAccounts').innerHTML=`<div class="cr-heading"><div><h1>Dashboard</h1><p>Account usage, project costs, and routing.</p></div><div class="cr-actions"><button class="cr-secondary" id="accountExport">${ic('down')} Export CSV</button><button class="cr-primary" id="accountAdd">${ic('plus')} Add account</button></div></div>
      <div class="cr-tools">${segmented('accountProvider',[['','All providers'],['codex','ChatGPT'],['claude','Claude']],accountProvider,'Provider')}<span class="sp"></span>${segmented('accountDays',[['7','7 days'],['30','30 days']],accountDays,'Usage date range')}<button class="cr-icon" id="accountRefresh" title="Refresh usage" aria-label="Refresh usage">${ic('repeat')}</button></div>
      <div id="accountStatus" role="status" class="cr-note"></div><div id="accountStats" class="cr-stats"></div><section id="crProjectCosts" class="cr-project-costs" aria-label="Project cost estimates"></section>
      <div class="cr-charts"><section class="cr-chart-card"><header><h2>Activity over time</h2>${segmented('accountMetric',[['attempts','Attempts'],['tokens','Tokens']],chartMetric,'Chart metric')}</header><div class="chart-legend"><span><i></i>ChatGPT</span><span><i class="claude"></i>Claude</span><small>UTC</small></div><div id="accountChart"></div><div id="accountChartCaption" class="cr-chart-caption" role="status"></div></section><section class="cr-chart-card"><header><h2>Tokens by model</h2><span>Reported usage</span></header><div id="accountModels"></div></section></div>
      <div class="cr-section-head"><h2>Connected accounts <small id="accountCount"></small></h2><span>Live availability · Provider limits</span></div><div id="accountRows"></div><div id="accountRouting"></div><p id="accountCoverage" class="cr-note"></p>`;
    on('accountAdd',()=>$('addAcctBtn').click()); on('accountExport',exportCsv);
    on('accountRefresh',()=>{engine.pollAccounts();loadAnalytics();});
    wireSegment('accountProvider',value=>{accountProvider=value;renderAccountRows();loadAnalytics();});
    wireSegment('accountDays',value=>{accountDays=value;loadAnalytics();});
    wireSegment('accountMetric',value=>{chartMetric=value;renderCharts();});
    let previousWidth=0;
    new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width!==previousWidth){previousWidth=width;renderCharts();}}).observe($('accountChart'));
    renderAccountRows();
  }
  async function loadAnalytics() {
    if (!$('accountDays')) return;
    const version=++requestVersion, provider=accountProvider;
    analytics=null;analyticsError='';renderAnalytics();$('accountStatus').textContent='Updating usage…';
    try {
      const [data,policy]=await Promise.all([json('/api/accounts/analytics?days='+accountDays+(provider?'&provider='+provider:'')),json('/api/accounts/routing')]);
      if(version!==requestVersion)return;
      analytics=data;routing=policy;renderAnalytics();renderAccountRows();
    } catch(e) {if(version!==requestVersion)return;analytics=null;analyticsError=e.message;renderAnalytics();}
  }
  function selectedAccounts() { return engine.state().accounts.filter(a=>!accountProvider||a.provider===accountProvider); }
  function available(a) {return !a.paused&&!['limited','unauthenticated'].includes(a.state?.kind);}
  function renderAnalytics() {
    if(!$('accountStats'))return;
    const accounts=selectedAccounts(), rows=analytics?.rows||[];
    const attempts=rows.reduce((n,r)=>n+r.attempts,0), completed=rows.reduce((n,r)=>n+r.completed,0),reported=rows.reduce((n,r)=>n+r.reported,0),tokens=rows.reduce((n,r)=>n+totalTokens(r),0);
    $('accountStatus').textContent=analyticsError?'Usage could not be loaded: '+analyticsError:'';
    $('accountStats').innerHTML=[[`${accounts.filter(available).length} / ${accounts.length}`,'Available accounts','Current routing pool'],[analytics?compact(attempts):'—','Attempts','Includes retries and account switches'],[reported?compact(tokens):'—','Reported tokens',reported?`${reported} attempts with token reports`:'No token reports in this period'],[attempts?Math.round(completed/attempts*100)+'%':'—','Completed','Share of recorded attempts']].map(([n,t,sub])=>`<div><span>${t}</span><strong>${n}</strong><small>${sub}</small></div>`).join('');
    $('accountCoverage').textContent=analytics?`Collection began ${new Date(analytics.since).toLocaleString()}. ${analytics.scope}`:'Historical usage is unavailable. Current account limits remain visible.';
    $('accountExport').disabled=!analytics;renderCharts();renderRouting();
  }
  function chartEmpty(title, text) {return `<div class="chart-empty">${ic('snippet')}<strong>${title}</strong><span>${text}</span></div>`;}
  let chartSignature='';
  function renderCharts() {
    if(!$('accountChart'))return;
    const signature=JSON.stringify([analytics,analyticsError,accountProvider,chartMetric,Math.round($('accountChart').getBoundingClientRect().width)]);
    if(signature===chartSignature)return;chartSignature=signature;
    const rows=analytics?.rows||[], attempts=rows.reduce((n,r)=>n+r.attempts,0), reports=rows.reduce((n,r)=>n+r.reported,0);
    const value=r=>chartMetric==='tokens'?totalTokens(r):r.attempts;
    const daily=(analytics?.dates||[]).map(date=>({date,codex:rows.filter(r=>r.date===date&&r.provider==='codex').reduce((n,r)=>n+value(r),0),claude:rows.filter(r=>r.date===date&&r.provider==='claude').reduce((n,r)=>n+value(r),0)}));
    const hasData=chartMetric==='tokens'?reports:attempts;
    $('accountChartCaption').textContent='';
    if(!analytics) $('accountChart').innerHTML=chartEmpty(analyticsError?'Usage unavailable':'Loading activity',analyticsError?'Refresh to try again.':'Reading recorded attempts…');
    else if(!hasData) $('accountChart').innerHTML=chartEmpty(chartMetric==='tokens'?'No token reports yet':'No recorded activity',chartMetric==='tokens'?'Tokens appear when a completed attempt reports usage.':'Activity appears after an attempt ends.');
    else {
      const width=Math.max(220,Math.round($('accountChart').getBoundingClientRect().width)), height=185,left=35,right=12,top=12,bottom=30;
      const maxRaw=Math.max(1,...daily.flatMap(d=>[d.codex,d.claude]));const magnitude=10**Math.floor(Math.log10(maxRaw));const max=chartMetric==='attempts'?Math.max(4,Math.ceil(maxRaw/4)*4):Math.ceil(maxRaw/magnitude)*magnitude;
      const x=i=>left+i*(width-left-right)/Math.max(1,daily.length-1),y=v=>height-bottom-v/max*(height-top-bottom);
      let svg=`<svg class="activity-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="Daily ${chartMetric} by provider">`;
      for(let i=0;i<=4;i++){const v=max*i/4;svg+=`<line x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/><text x="${left-7}" y="${y(v)+3}" text-anchor="end">${compact(v)}</text>`;}
      for(const p of ['codex','claude'].filter(p=>!accountProvider||p===accountProvider)){
        const path=daily.map((d,i)=>(i?'L':'M')+x(i).toFixed(2)+' '+y(d[p]).toFixed(2)).join(' ');
        svg+=`<path class="chart-area ${p}" d="${path} L${x(daily.length-1)} ${y(0)} L${x(0)} ${y(0)} Z"/><path class="chart-line ${p}" d="${path}"/>`;
      }
      const labelCount=Math.min(daily.length,Math.max(2,Math.floor((width-left-right)/65)));
      const labelIndices=new Set(Array.from({length:labelCount},(_,i)=>Math.round(i*(daily.length-1)/Math.max(1,labelCount-1))));
      daily.forEach((d,i)=>{
        if(labelIndices.has(i))svg+=`<text x="${x(i)}" y="${height-8}" text-anchor="${i===0?'start':i===daily.length-1?'end':'middle'}">${new Date(d.date+'T12:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'})}</text>`;
        const hitWidth=(width-left-right)/Math.max(1,daily.length-1);
        svg+=`<g tabindex="0" role="button" data-day="${i}" aria-label="${d.date}: ChatGPT ${d.codex}, Claude ${d.claude} ${chartMetric}"><rect class="chart-hit" x="${Math.max(left,x(i)-hitWidth/2)}" y="${top}" width="${i===0||i===daily.length-1?hitWidth/2:hitWidth}" height="${height-bottom-top}"/><title>${d.date}: ChatGPT ${d.codex}, Claude ${d.claude} ${chartMetric}</title></g>`;
      });
      $('accountChart').innerHTML=svg+'</svg>';
      const inspect=b=>{const d=daily[Number(b.dataset.day)];$('accountChartCaption').textContent=`${d.date} · ChatGPT ${compact(d.codex)} · Claude ${compact(d.claude)} ${chartMetric}`;};
      $('accountChart').querySelectorAll('[data-day]').forEach(b=>{b.onclick=()=>inspect(b);b.onfocus=()=>inspect(b);b.onpointerenter=()=>inspect(b);b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(b);}};});
      $('accountChartCaption').textContent='Select a day to inspect activity.';
    }
    const models=new Map();rows.forEach(r=>models.set(r.model,(models.get(r.model)||0)+totalTokens(r)));
    const entries=[...models].filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]),tokens=entries.reduce((n,[,v])=>n+v,0);
    if(!entries.length){$('accountModels').innerHTML=chartEmpty(!analytics?'Usage unavailable':reports?'Zero tokens reported':'No token reports yet',reports?'Reported usage totals zero in this period.':'Model usage appears when token reports arrive.');return;}
    const colors=['var(--chart-green)','var(--chart-purple)','#648cae','#b59060','#a57e9b','#83916a'];let offset=0;
    const slices=entries.map(([m,n],i)=>{const fraction=n/tokens*100;const circle=`<circle cx="60" cy="60" r="46" pathLength="100" fill="none" stroke="${colors[i%colors.length]}" stroke-width="13" stroke-dasharray="${fraction} ${100-fraction}" stroke-dashoffset="${-offset}"><title>${esc(m)}: ${n.toLocaleString()} tokens</title></circle>`;offset+=fraction;return circle;}).join('');
    $('accountModels').innerHTML=`<div class="model-chart"><div class="model-donut"><svg viewBox="0 0 120 120" role="img" aria-label="${tokens.toLocaleString()} reported tokens by model">${slices}</svg><div><strong>${compact(tokens)}</strong><small>tokens</small></div></div><div class="model-legend">${entries.map(([m,n],i)=>`<div title="${esc(m)}: ${n.toLocaleString()} tokens"><i style="background:${colors[i%colors.length]}"></i><span>${esc(m)}</span><strong>${n/tokens<.01?'&lt;1':Math.round(n/tokens*100)}%</strong></div>`).join('')}</div></div>`;
  }
  function quotaWindows(a) {
    const q=a.quota;
    const windows=(q?.windows?.length?q.windows:q?[{...q.fiveHour,label:'5-hour'},{...q.sevenDay,label:'7-day'},...(q.weeklyScoped||[])]:[]).filter(w=>Number.isFinite(w.utilization));
    const five=windows.find(w=>/^5[ -]hour$/i.test(w.label)),seven=windows.find(w=>/^7[ -]day$/i.test(w.label));
    return {five,seven,other:windows.filter(w=>w!==five&&w!==seven),all:windows};
  }
  function quotaFreshness(a) { return a.quotaStale?`<small class="cr-stale">Cached reading${a.quotaAt?' · '+esc(new Date(a.quotaAt).toLocaleString()):''}</small>`:a.quotaError?'<small class="cr-stale">Usage temporarily unavailable</small>':''; }
  function quotaCell(a,w,label) {
    if(!w)return `<div class="cr-quota quota-missing"><span class="quota-label">${esc(label)}</span><small>Not reported</small></div>`;
    const p=Math.max(0,Math.min(100,Math.round(w.utilization*(a.provider==='codex'?100:1))));
    const date=w.resetsAt?new Date(typeof w.resetsAt==='number'?w.resetsAt*1000:w.resetsAt):null;
    return `<div class="cr-quota"><div><span class="quota-label">${esc(label)}</span><strong>${p}%</strong></div><div class="cr-track ${p>=90?'high':''}" role="meter" aria-label="${esc(label)} used" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div><small>${date&&!isNaN(date)?'Resets '+esc(date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})):'Reset time not reported'}</small></div>`;
  }
  function quota(a) {return quotaWindows(a).all.map(w=>quotaCell(a,w,w.label)).join('')+quotaFreshness(a);}
  function renderAccountRows() {
    if(!$('accountRows'))return;
    const list=selectedAccounts();$('accountCount').textContent=list.length;
    const html=`<div class="cr-account-table"><div class="cr-account-head"><span>Account</span><span>Availability</span><span>5-hour window</span><span>7-day window</span><span>Other limits</span><span class="sr-only">Actions</span></div>${list.map(a=>{
      const w=quotaWindows(a);
      return `<article class="cr-account-row"><div><button class="cr-identity identity-button" data-manage="${esc(a.name)}">${identity(a)}</button>${quotaFreshness(a)}</div><div class="account-availability"><span class="cr-account-state ${available(a)?'ready':a.paused?'paused':'limited'}">${esc(accountStatus(a))}</span>${a.nextUp?'<small class="next-badge">Next message</small>':''}</div>${quotaCell(a,w.five,'5-hour window')}${quotaCell(a,w.seven,'7-day window')}<div class="other-quotas">${w.other.length?quotaCell(a,w.other[0],w.other[0].label)+(w.other.length>1?`<button class="cr-text-button" data-manage="${esc(a.name)}">+${w.other.length-1} more limits</button>`:''):quotaCell(a,null,'Other limits')}</div><button class="cr-icon" data-account-menu="${esc(a.name)}" aria-label="Manage ${esc(accountName(a))}">${ic('more')}</button></article>`;
    }).join('')||'<div class="cr-empty">No accounts connected. Add an account to get started.</div>'}</div>`;
    if(html!==accountSignature){
      accountSignature=html;$('accountRows').innerHTML=html;
      $('accountRows').querySelectorAll('[data-manage]').forEach(b=>b.onclick=()=>accountDetail(engine.state().accounts.find(a=>a.name===b.dataset.manage)));
      $('accountRows').querySelectorAll('[data-account-menu]').forEach(b=>b.onclick=()=>{
        const a=engine.state().accounts.find(a=>a.name===b.dataset.accountMenu);
        openMenu(b,[{label:a.nextUp?'Next message':'Use for next message',icon:'up',disabled:!available(a)||a.nextUp,run:()=>mutate(b,'/api/accounts/active',{name:a.name},'Next account updated.')},{label:'Account details',icon:'user',run:()=>accountDetail(a)},{label:a.paused?'Resume account':'Pause account',icon:'repeat',run:()=>mutate(b,'/api/accounts/paused',{name:a.name,paused:!a.paused},a.paused?'Account resumed.':'Account paused.')}]);
      });
    }
    renderAnalytics();
  }
  async function mutate(button,url,body,message) {button.disabled=true;try{await json(url,body);await engine.pollAccounts();if(section==='accounts')await loadAnalytics();toast(message);return true;}catch(e){toast(e.message);return false;}finally{if(button.isConnected)button.disabled=false;}}
  function renderRouting() {
    if(!$('accountRouting'))return;
    $('accountRouting').innerHTML=`<div class="routing-summary">${ic('repeat')}<span>Account routing${routing?' · '+[...new Set(selectedAccounts().map(a=>a.provider))].map(p=>providerName(p)+': '+(strategyLabels[routing.policies?.[p]?.strategy]||'Stay on current')).join(' · '):''}</span><button class="cr-text-button" id="manageRouting">Manage routing</button></div>`;
    on('manageRouting',()=>settings('routing'));
  }
  function accountDetail(a) {
    if(!a)return;
    const d=document.createElement('dialog');d.className='cr-dialog';d.id='accountDetail';d.setAttribute('aria-label','Account details');
    const rows=(analytics?.rows||[]).filter(r=>r.account===a.name),reports=rows.reduce((n,r)=>n+r.reported,0);
    d.innerHTML=`<header><h2>Account details</h2><button class="cr-icon" data-close aria-label="Close account details">${ic('x')}</button></header><div class="cr-identity detail-identity">${identity(a)}</div><form id="accountNameForm"><label for="accountLabel">Account name</label><div class="name-edit"><input id="accountLabel" value="${esc(a.label||'')}" placeholder="${esc(accountName(a))}" maxlength="80"><button class="cr-secondary">Save</button></div><small class="cr-note">Leave empty to use the name from your provider.</small><div id="accountNameStatus" class="cr-note" role="status"></div></form><h3>Usage limits</h3><div class="detail-quotas">${quota(a)||'<p>No usage limits reported.</p>'}</div><p>${analytics?rows.reduce((n,r)=>n+r.attempts,0)+' recorded attempts · '+(reports?compact(rows.reduce((n,r)=>n+totalTokens(r),0))+' reported tokens':'No token reports')+' in the selected period.':'Activity for this period is unavailable.'}</p><div class="cr-dialog-actions"><button class="cr-secondary" data-pause>${a.paused?'Resume account':'Pause account'}</button><button class="cr-secondary" data-next ${!available(a)||a.nextUp?'disabled':''}>${a.nextUp?'Next message':'Use for next message'}</button><button class="cr-secondary" data-action="login">Sign in again</button></div><p>Pausing excludes this account from future attempts. Running conversations continue.</p><details class="account-advanced"><summary>Connection details & advanced controls</summary><p>Connection ID: <code>${esc(a.name)}</code> · ${providerName(a.provider)}</p><div class="cr-dialog-actions">${a.state?.kind==='limited'&&!a.paused?'<button class="cr-secondary" data-action="force">Override reported limit</button>':''}${a.provider==='claude'?'<button class="cr-secondary" data-action="consent">Grant design access</button><button class="cr-secondary" data-action="design">Claude Design login</button>':''}<button class="cr-secondary danger" data-action="remove">Remove account</button></div></details>`;
    document.body.append(d);d.showModal();d.addEventListener('close',()=>d.remove());d.querySelector('[data-close]').onclick=()=>d.close();
    d.querySelector('[data-pause]').onclick=async e=>{if(await mutate(e.target,'/api/accounts/paused',{name:a.name,paused:!a.paused},a.paused?'Account resumed.':'Account paused.'))d.close();};
    d.querySelector('[data-next]').onclick=e=>mutate(e.target,'/api/accounts/active',{name:a.name},'Next account updated.');
    d.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const action=b.dataset.action;
      if(action==='remove'){
        const confirmed=await engine.confirm({title:'Remove '+accountName(a)+'?',message:'This removes the saved login from the panel. Future attempts will use the remaining accounts.',confirmText:'Remove account',danger:true});
        if(!confirmed)return;
        if(await mutate(b,'/api/accounts/remove',{name:a.name},'Account removed.'))d.close();
        return;
      }
      if(action==='login')d.close();engine.accountAction(action,a,b);
    });
    d.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await json('/api/accounts/label',{name:a.name,label:$('accountLabel').value});await engine.pollAccounts();a=engine.state().accounts.find(x=>x.name===a.name)||a;d.querySelector('.detail-identity').innerHTML=identity(a);$('accountNameStatus').textContent='Account name saved.';renderSendAccounts();}catch(err){$('accountNameStatus').textContent=err.message;}finally{b.disabled=false;}};
  }
  function exportCsv() {
    if (!analytics) return;
    const keys=['date','account','provider','model','attempts','completed','failed','interrupted','reported','input','output','cached','cacheWrite'];
    const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
    const csv=[keys.join(','),...analytics.rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); const a=document.createElement('a');a.href=url;a.download='x056-usage-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  new MutationObserver(() => { const connected = !$('dot').classList.contains('off'); $('crConnection').textContent = connected ? 'Connected' : 'Reconnecting'; $('crConnection').classList.toggle('connected',connected); }).observe($('dot'),{attributes:true});
    // Modern destinations reuse the engine's working OAuth, plugin, MCP, and model handlers.
  const utilityHome=document.createElement('div');utilityHome.hidden=true;document.body.append(utilityHome);
  document.querySelectorAll('.pop').forEach(el=>utilityHome.append(el));
  const utility=document.createElement('dialog');utility.className='cr-dialog utility-dialog';utility.id='utilityDialog';document.body.append(utility);
  let utilityElement=null, settingSection='general', connectionSection='plugins', defaultProvider='claude';
  function closeUtility() {if(preferences.open)preferences.querySelectorAll('.pop').forEach(el=>el.hidden=false);if(utility.open)utility.close();if(utilityElement){utilityElement.hidden=true;utilityElement.classList.remove('integrated-pop');utilityHome.append(utilityElement);utilityElement=null;}}
  utility.addEventListener('close',()=>{if(!utility.open)closeUtility();});
  function openUtility(el) {
    if(preferences.contains(el)||$('automationContent').contains(el)){el.hidden=false;return;}
    const destinations={defaultsPop:'models',pluginsPop:'connections',mcpSrvPop:'connections',passkeyPop:'security'};
    if(destinations[el.id]){if(el.id==='pluginsPop')connectionSection='plugins';if(el.id==='mcpSrvPop')connectionSection='mcp';settings(destinations[el.id]);return;}
    if(el.id==='cronPop'){showSection('automations');return;}
    closeUtility();utilityElement=el;utility.classList.toggle('agent-utility',el.id==='subPop');
    const title=el.querySelector('h2')?.textContent||'Controls';utility.setAttribute('aria-label',title);
    utility.innerHTML=`<header><h2>${esc(title)}</h2><button class="cr-icon" aria-label="Close ${esc(title)}">${ic('x')}</button></header><div class="utility-body"></div>`;
    utility.querySelector('button').onclick=closeUtility;utility.querySelector('.utility-body').append(el);el.hidden=false;el.classList.add('integrated-pop');
    if(!utility.open)utility.showModal();
  }
  const oldPreferenceForm=preferences.querySelector('form');
  const generalFields=[...oldPreferenceForm.querySelectorAll('fieldset')];
  function mountControl(id,host,button) {const el=$(id);host.append(el);el.classList.add('integrated-pop');el.hidden=false;if(button)$(button).click();}
  function settingsTab(tab) {
    if(typeof tab!=='string')tab='general';settingSection=tab;
    if(preferences.contains(menu)){if(menu.matches(':popover-open'))menu.hidePopover();document.body.append(menu);}
    preferences.querySelectorAll('.pop').forEach(el=>{utilityHome.append(el);el.hidden=true;});
    preferences.innerHTML=`<div class="settings-shell"><nav class="settings-nav" aria-label="Settings"><h2>Settings</h2>${[['general','auto','General'],['models','sparkles','Models'],['routing','repeat','Routing'],['connections','plug','Connections'],['security','key','Security']].map(([id,icon,label])=>`<button data-settings="${id}" aria-current="${id===tab?'page':'false'}">${ic(icon)}<span>${label}</span></button>`).join('')}</nav><section class="settings-content"><header><h2>${{general:'General',models:'Model defaults',routing:'Account routing',connections:'Connections',security:'Security'}[tab]}</h2><button class="cr-icon" data-close-settings aria-label="Close settings">${ic('x')}</button></header><div id="settingsBody"></div></section></div>`;
    preferences.querySelector('[data-close-settings]').onclick=()=>preferences.close();
    preferences.querySelectorAll('[data-settings]').forEach(b=>b.onclick=()=>settingsTab(b.dataset.settings));
    const body=$('settingsBody');
    if(tab==='general'){
      body.innerHTML=`<h3>Appearance</h3><div class="theme-choices">${[['system','auto','Follow device'],['light','sun','Light'],['dark','moon','Dark']].map(([v,i,t])=>`<button data-theme-choice="${v}" aria-pressed="${engine.theme()===v}">${ic(i)}<span>${t}</span></button>`).join('')}</div><div id="displayFields"></div><div class="setting-row"><span><strong>Notifications</strong><small>Messages and requests that need your attention</small></span><button class="cr-secondary" id="settingsNotify">Manage</button></div><div class="setting-row"><span><strong>Keyboard shortcuts</strong><small>Navigate and send messages from your keyboard</small></span><button class="cr-secondary" id="settingsShortcuts">View shortcuts</button></div>`;
      for(const field of generalFields)$('displayFields').append(field);
      for(const name of ['open','maximize'])preferences.querySelector(`input[name="${name}"][value="${prefs[name]}"]`).checked=true;
      body.querySelectorAll('[data-theme-choice]').forEach(b=>b.onclick=()=>{engine.setTheme(b.dataset.themeChoice);syncTheme();body.querySelectorAll('[data-theme-choice]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
      on('settingsNotify',e=>notificationMenu(e.currentTarget));on('settingsShortcuts',()=>$('shortcutsBtn').click());
    } else if(tab==='models') {
      body.innerHTML=segmented('defaultProvider',[['claude','Claude'],['codex','ChatGPT']],defaultProvider,'Model defaults provider')+'<p>Choose the effort selected when you pick a model. Changes sync across your devices.</p><form id="modelDefaultsForm"><div id="modelDefaultRows">Loading defaults…</div><div class="cr-dialog-actions"><button class="cr-primary" disabled>Save defaults</button></div><p id="modelDefaultStatus" role="status"></p></form>';
      wireSegment('defaultProvider',value=>{defaultProvider=value;settingsTab('models');});
      const selected=defaultProvider,form=$('modelDefaultsForm'),options=engine.defaultModelOptions(selected);
      json('/api/settings').then(data=>{
        if(!form.isConnected||selected!==defaultProvider)return;
        $('modelDefaultRows').innerHTML=options.map(m=>`<label class="setting-row"><strong>${esc(m.label)}</strong><select data-model="${esc(m.value)}" aria-label="Effort for ${esc(m.label)}">${m.efforts.map(e=>`<option value="${esc(e.value)}" ${data.modelEffort?.[m.value]===e.value?'selected':''}>${esc(e.label)}</option>`).join('')}</select></label>`).join('')||'<p>No model catalog is available. Connect an account and refresh to load its supported models.</p>';
        form.querySelector('button').disabled=!options.length;
      }).catch(e=>{if(form.isConnected)$('modelDefaultRows').textContent=e.message;});
      form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const current=await json('/api/settings'),map={...current.modelEffort};form.querySelectorAll('[data-model]').forEach(select=>{if(select.value)map[select.dataset.model]=select.value;else delete map[select.dataset.model];});await json('/api/settings/model-effort',{modelEffort:map});if(form.isConnected)$('modelDefaultStatus').textContent='Model defaults saved.';}catch(err){if(form.isConnected)$('modelDefaultStatus').textContent=err.message;}finally{if(form.isConnected)button.disabled=false;}};
    }
    else if(tab==='connections') {
      body.innerHTML=segmented('connectionType',[['plugins','Plugins'],['mcp','MCP servers']],connectionSection,'Connection type')+'<div id="connectionControls"></div>';
      wireSegment('connectionType',v=>{connectionSection=v;settingsTab('connections');});
      mountControl(connectionSection==='plugins'?'pluginsPop':'mcpSrvPop',$('connectionControls'),connectionSection==='plugins'?'pluginsBtn':'mcpSrvBtn');
    } else if(tab==='security') {
      body.innerHTML='<h3>Passkeys</h3><p>Use your device to sign in with Face ID, Touch ID, or a security key.</p><div id="securityControls"></div><div class="setting-row"><span><strong>Sign out</strong><small>End your panel session on this browser</small></span><button class="cr-secondary" id="settingsLogout">Sign out</button></div>';
      mountControl('passkeyPop',$('securityControls'),'passkeyBtn');on('settingsLogout',()=>$('tokenBtn').click());
    } else if(tab==='routing'){
      body.innerHTML='<p>Choose how new turns use each provider’s accounts. Priority also breaks ties and orders fallback accounts.</p><div id="routingSettings" role="status">Loading routing…</div>';
      json('/api/accounts/routing').then(policy=>{routing=policy;if(settingSection!=='routing'||!$('routingSettings'))return;renderRoutingSettings(policy);}).catch(e=>{if($('routingSettings'))$('routingSettings').textContent=e.message;});
    }
  }
  const strategyLabels={'sticky':'Stay on current','priority':'Priority order','round-robin':'Round robin','least-busy':'Least busy','wait':'Wait for reset'};
  const strategyHelp={'sticky':'Keep the current account until it becomes unavailable, then use the next available account.','priority':'Start each turn on the highest-priority available account.','round-robin':'Rotate through available accounts on each new turn.','least-busy':'Use the account with the fewest active conversation turns. Priority breaks ties.','wait':'Keep the current account. If it hits a limit, wait and retry when the reset time arrives. Stop cancels the wait.'};
  function renderRoutingSettings(policy) {
    const host=$('routingSettings');if(!host)return;
    host.innerHTML=['codex','claude'].map(provider=>{
      const accounts=engine.state().accounts.filter(a=>a.provider===provider),saved=policy.policies?.[provider]||{strategy:policy.autoSwitch[provider]?'sticky':'wait',order:accounts.map(a=>a.name)};
      const order=[...new Set([...saved.order,...accounts.map(a=>a.name)])].filter(n=>accounts.some(a=>a.name===n));
      return `<form class="routing-policy" data-provider="${provider}"><header><h3>${providerName(provider)}</h3><span>${accounts.length} accounts</span></header><label class="routing-strategy-label">Load balancing<select data-strategy aria-label="${providerName(provider)} load balancing">${Object.entries(strategyLabels).map(([k,v])=>`<option value="${k}" ${k===saved.strategy?'selected':''}>${v}</option>`).join('')}</select></label><p data-strategy-help>${strategyHelp[saved.strategy]}</p><ol class="routing-order">${order.map((name,i)=>{const a=accounts.find(a=>a.name===name);return `<li data-account="${esc(name)}"><span class="routing-rank">${i+1}</span><span class="cr-identity">${identity(a)}</span><small>${policy.loads?.[name]||0} active</small><button type="button" class="cr-icon" data-move="-1" aria-label="Move ${esc(accountName(a))} up" ${i===0?'disabled':''}>${ic('up')}</button><button type="button" class="cr-icon" data-move="1" aria-label="Move ${esc(accountName(a))} down" ${i===order.length-1?'disabled':''}>${ic('down')}</button></li>`;}).join('')}</ol><footer><span data-save-status role="status"></span><button class="cr-primary" ${accounts.length?'':'disabled'}>Save routing</button></footer></form>`;
    }).join('');
    host.querySelectorAll('form').forEach(form=>{
      const select=form.querySelector('[data-strategy]'),status=form.querySelector('[data-save-status]');
      select.onchange=()=>{form.querySelector('[data-strategy-help]').textContent=strategyHelp[select.value];status.textContent='Unsaved changes';};
      form.querySelectorAll('[data-move]').forEach(button=>button.onclick=()=>{
        const row=button.closest('li'),list=row.parentElement;
        if(button.dataset.move==='-1'&&row.previousElementSibling)list.insertBefore(row,row.previousElementSibling);
        else if(button.dataset.move==='1'&&row.nextElementSibling)list.insertBefore(row.nextElementSibling,row);
        [...list.children].forEach((li,i)=>{li.querySelector('.routing-rank').textContent=i+1;li.querySelector('[data-move="-1"]').disabled=i===0;li.querySelector('[data-move="1"]').disabled=i===list.children.length-1;});
        status.textContent='Unsaved changes';button.focus();
      });
      form.onsubmit=async e=>{e.preventDefault();const controls=[...form.querySelectorAll('button,select')],disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);status.textContent='Saving…';
        try{routing=await json('/api/accounts/routing',{provider:form.dataset.provider,strategy:select.value,order:[...form.querySelectorAll('[data-account]')].map(li=>li.dataset.account)});await engine.pollAccounts();renderRouting();status.textContent='Routing saved';}
        catch(err){status.textContent=err.message;}
        finally{controls.forEach((c,i)=>c.disabled=disabled[i]);}
      };
    });
  }
  preferences.classList.add('settings-dialog');
  mountControl('cronPop',$('automationContent'));
  const menu=document.createElement('div');menu.id='controlMenu';menu.className='control-menu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');document.body.append(menu);
  let menuAnchor=null;
  function openMenu(anchor,items) {
    if(menu.matches(':popover-open'))menu.hidePopover();
    menuAnchor=anchor; (anchor.closest('dialog')||document.body).append(menu);
    menu.innerHTML=items.map((it,i)=>`<button role="menuitem" data-menu-item="${i}" ${it.disabled?'disabled':''}>${ic(it.icon)}<span>${esc(it.label)}</span>${it.checked?ic('check'):''}</button>`).join('');
    menu.querySelectorAll('button').forEach(b=>b.onclick=()=>{menu.hidePopover();items[Number(b.dataset.menuItem)].run();});
    menu.showPopover();
    const rect=anchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.right-menu.offsetWidth))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,rect.bottom+7))+'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  menu.addEventListener('keydown',e=>{const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();menu.hidePopover();menuAnchor?.focus();}if(e.key==='Tab')menu.hidePopover();});
  function syncTheme(){const name=engine.theme();$('crTheme').innerHTML=ic({system:'auto',light:'sun',dark:'moon'}[name]);$('crTheme').ariaLabel='Appearance: '+(name==='system'?'Follow device theme':name);}
  function themeMenu(anchor){openMenu(anchor,[['system','auto','Follow device theme'],['light','sun','Light'],['dark','moon','Dark']].map(([value,icon,label])=>({label,icon,checked:engine.theme()===value,run:()=>{engine.setTheme(value);syncTheme();}})));}
  function notificationMenu(anchor){const s=engine.state(),count=Object.keys(s.notifications).length;openMenu(anchor,[{label:'Unread conversations'+(count?' · '+count:''),icon:'bell',run:()=>{if(preferences.open)preferences.close();boardFilter='unread';shell.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.filter==='unread'));showSection('board');}},{label:'Message approvals'+($('mcpApprovalsBadge').textContent?' · '+$('mcpApprovalsBadge').textContent:''),icon:'sparkles',run:()=>$('mcpApprovalsBtn').click()},{label:'Browser notifications',icon:'bell',run:()=>$('notifyBtn').click()}]);}
  function activityMenu(anchor){openMenu(anchor,[{label:'Usage & subagents',icon:'sparkles',run:()=>$('subagentsBtn').click()},{label:'Workflow runs',icon:'fanout',disabled:$('wfBtn').hidden,run:()=>$('wfBtn').click()},{label:'Message approvals',icon:'bell',run:()=>$('mcpApprovalsBtn').click()}]);}
  function conversationMenu(anchor){const s=engine.state();openMenu(anchor,[{label:'Rename conversation',icon:'compose',disabled:!s.sessionId,run:engine.renameConversation},{label:'Resume a session',icon:'history',run:()=>$('resumeBtn').click()},{label:'Copy conversation ID',icon:'copy',disabled:!s.sessionId,run:()=>navigator.clipboard.writeText(s.sessionId).then(()=>toast('Conversation ID copied.')).catch(()=>toast('Could not copy the conversation ID.'))},{label:'Remove from panel',icon:'x',disabled:!s.sessionId||!!s.running[s.projectId]?.[s.sessionId],run:engine.removeConversation}]);}
  const runningLabel=document.createElement('div');runningLabel.id='runningAccountLabel';runningLabel.hidden=true;content.querySelector('.composer').before(runningLabel);
  $('autopilotBtn').insertAdjacentHTML('beforeend','<span>Autopilot</span>');
  const syncActivity=()=>{$('chatActivityCount').textContent=$('subagentsBadge').textContent||'';};
  new MutationObserver(syncActivity).observe($('subagentsBadge'),{childList:true,subtree:true,characterData:true});
  new MutationObserver(syncTheme).observe($('themeBtn'),{childList:true,subtree:true});syncTheme();

  setMode('closed'); projectNav(false); refresh();
  return { renderRuns, showCosts:()=>{renderCostDetails();costDialog.showModal();loadProjectCosts(true);}, showSettings:settings, conversationMenu, openUtility, closeUtility, error:message=>{ $('crBoardError').textContent=message; }, open, refresh, event, rememberPosition, restorePosition, isOpen:()=>mode!=='closed', beforeSwitch:rememberPosition, afterHistory:restorePosition, showAccounts:()=>showSection('accounts') };
};
