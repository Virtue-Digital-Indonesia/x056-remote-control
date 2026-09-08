/* Presentation layer for the existing authenticated conversation engine. */
window.createControlRoom = function (engine) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const ic = name => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const iconButton = (id, name, label) => `<button class="cr-icon" id="${id}" aria-label="${label}" title="${label}">${ic(name)}</button>`;
  const routeCache=new Map(),routeFetched=new Map(),routePending=new Map();
  const main = document.querySelector('body > main'); main.id = 'conversationSurface';
  const legacyNav = document.querySelector('body > aside'); legacyNav.id = 'projectDrawer';
  const scroll = main.querySelector('.scroll');
  const content = document.createElement('div'); content.className = 'focus-main';
  while (main.firstChild) content.append(main.firstChild);
  main.append(content);
  main.insertAdjacentHTML('afterbegin', `<nav id="focusNav" aria-label="Focus navigation"><button class="cr-logo" id="focusHome" title="Back to Control room">x0</button>${iconButton('focusBack','left','Back to Control room')}${iconButton('focusSearch','search','Search conversations')}${iconButton('focusNew','compose','New conversation')}<span class="sp"></span>${iconButton('focusAccounts','user','Accounts')}${iconButton('focusSettings','gear','Display settings')}</nav>`);
  // The existing toolbar actions remain wired; less-used actions live in More.
  main.querySelector('.topbar').insertAdjacentHTML('beforeend', `<button class="cr-secondary" id="chatActivity">${ic('sparkles')}<span>Activity</span><small id="chatActivityCount"></small></button>${iconButton('chatResults','file','Conversation results')}${iconButton('chatRefresh','refresh','Refresh conversation')}${iconButton('chatMax','expand','Maximize conversation')}${iconButton('chatClose','x','Close conversation')}`);
  const shell = document.createElement('section'); shell.id = 'controlRoom'; shell.setAttribute('aria-label', 'Control room');
  shell.innerHTML = `<header class="cr-top"><button class="cr-logo" id="crHome">x0<span>x056</span></button><nav aria-label="Main navigation"><button id="crBoardTab" aria-current="page">Control room</button><button id="crAccountsTab">Accounts</button></nav><span class="sp"></span><span id="crConnection" class="cr-connection">Connecting</span>${iconButton('crProjects','folder','Projects')}${iconButton('crTheme','moon','Change theme')}${iconButton('crSettings','gear','Display settings')}${iconButton('crNotifications','bell','Notifications')}</header>
  <div id="crBoard" class="cr-page"><div class="cr-heading"><div><div class="cr-eyebrow">CONVERSATIONS</div><h1 id="crScopeTitle">All projects</h1><p id="crScopeSubtitle">Conversations across your workspace</p></div><div class="cr-actions">${iconButton('crScopeActions','more','Project actions')}<button id="crSelectToggle" class="cr-secondary">Select</button><button class="cr-primary" id="crNew">${ic('plus')} New conversation</button></div></div><div id="crStats" class="cr-stats"></div><div class="cr-tools"><div class="cr-tabs" role="group" aria-label="Conversation filter"><button data-filter="all" class="selected">All conversations</button><button data-filter="question">Needs input</button><button data-filter="active">Running</button><button data-filter="unread">Unread</button><button data-filter="archived">Archived</button></div><label class="cr-search">${ic('search')}<input id="crSearch" type="search" placeholder="Search conversations…" aria-label="Search conversations" /></label><select id="crProjectFilter" aria-label="Filter by project"><option value="">All projects</option></select></div><div id="crBulkBar" class="workspace-bulk" hidden><strong>0 selected</strong><button id="crBulkAll">Select all matches</button><button id="crBulkClear">Clear</button><button data-bulk="archive">Archive</button><button data-bulk="restore">Restore</button><button data-bulk="tag">Tags</button><button data-bulk="pin">Pin</button><button data-bulk="unpin">Unpin</button><button data-bulk="read">Mark read</button><button data-bulk="unread">Mark unread</button></div><div id="crBoardError" role="status"></div><div class="cr-board" id="crLanes"></div></div>
  <div id="crAccounts" class="cr-page" hidden></div><div id="crAutomations" class="cr-page" hidden><div class="cr-heading"><div><h1>Automations</h1><p>Scheduled messages and conversation autopilots.</p></div><button id="refreshAutomations" class="cr-secondary">Refresh</button></div><section id="automationAutopilots" aria-label="Conversation autopilots"></section><header class="automation-section-heading"><h2>Scheduled messages</h2></header><div id="automationContent"></div></div><div id="crToast" role="status" hidden></div>`;
  document.body.prepend(shell);
  const workspace = document.createElement('div'); workspace.id = 'crWorkspace';
  $('crBoard').before(workspace);
  workspace.innerHTML = `<nav id="crProjectNav" aria-label="Projects"><header><span>Projects</span>${iconButton('crAddProject','plus','Add project')}</header><label class="cr-project-search">${ic('search')}<input id="crProjectSearch" type="search" aria-label="Find a project" placeholder="Find a project" /></label><div id="crProjectLinks"></div><button id="crManageProjects" class="cr-project-manage">${ic('folder')} Manage projects</button></nav>`;
  workspace.append($('crBoard'), $('crAccounts'), $('crAutomations'));
  workspace.insertAdjacentHTML('beforeend', `<div id="crArtifacts" class="cr-page" hidden><div class="cr-heading"><div><h1>Artifact library</h1><p>Saved screenshots, files, previews and reported tests.</p></div><div class="workspace-actions"><button id="artifactRefresh" class="cr-secondary">Refresh</button><button id="artifactAdd" class="cr-primary">Add output</button></div></div><div class="workspace-tools"><label class="cr-search">${ic('search')}<input type="search" id="artifactSearch" aria-label="Search artifacts" placeholder="Search outputs…"></label><select id="artifactProject" aria-label="Artifact project"></select><div class="cr-tabs" id="artifactKinds"><button data-kind="" class="selected">All</button><button data-kind="image">Screenshots</button><button data-kind="file">Files</button><button data-kind="preview">Previews</button><button data-kind="test">Tests</button></div></div><div id="artifactItems" class="artifact-grid"></div></div><div id="crPlanner" class="cr-page" hidden><div class="cr-heading"><div><h1>Queue planner</h1><p>Schedule messages and decide what runs next.</p></div><div class="workspace-actions"><button id="plannerRefresh" class="cr-secondary">Refresh</button><button id="plannerAdd" class="cr-primary">Plan a message</button></div></div><div class="workspace-tools"><select id="plannerProject" aria-label="Queue project"></select><span class="cr-note">Messages run in order per conversation. Other conversations can run in parallel.</span></div><div id="plannerItems"></div></div>`);
  const primaryNav = shell.querySelector('.cr-top nav'); primaryNav.className = 'cr-primary-nav';
  $('crProjectNav').prepend(primaryNav);
  $('crBoardTab').innerHTML = ic('menu') + '<span>Control room</span>';
  $('crAccountsTab').innerHTML = ic('chart') + '<span>Dashboard</span>';
  primaryNav.insertAdjacentHTML('beforeend', '<button id="crAutomationsTab">'+ic('alarm')+'<span>Automations</span></button>');
  primaryNav.insertAdjacentHTML('beforeend','<button id="crArtifactsTab">'+ic('file')+'<span>Artifacts</span></button><button id="crPlannerTab">'+ic('menu')+'<span>Queue planner</span></button>');
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
  let prefs = { open: 'max', maximize: 'modal' };
  try { const saved = JSON.parse(localStorage.getItem('x056_display_preferences') || localStorage.getItem('x056_draft_chat_preferences_v1') || '{}'); if (['side','max','maximized'].includes(saved.open)) prefs.open = saved.open === 'maximized' ? 'max' : saved.open; if (['page','modal'].includes(saved.maximize)) prefs.maximize = saved.maximize; } catch {}
  const sectionScroll = {board:0,accounts:0,automations:0,artifacts:0,planner:0};
  let accountProvider = '', accountDays = '7', chartMetric = 'attempts', selectedSendAccount = '', pickerBusy = false;
  let conversationMeta={},bulkMode=false,bulkSelection=new Set(),bulkCandidates=[],artifactRows=[],plannerRows={};
  let recentLimit=10, selectedProject='', projectNavSignature='', sendAccountSignature='';
  let dismissedProjects=[],showDismissedProjects=false;
  const messageActivity=new Map(),messageMetadata=new Map();
  try{const saved=JSON.parse(localStorage.getItem('x056_dismissed_projects')||'[]');if(Array.isArray(saved))dismissedProjects=saved.filter(x=>typeof x==='string');}catch{}
  try { selectedProject=localStorage.getItem('x056_project_scope') || ''; } catch {}
  let mode = 'closed', section = 'board', boardFilter = 'all', renderTimer, accountTimer, returnFocus;
  let boardSignature = '', accountSignature = '', analytics = null, routing = null, analyticsError = '', requestVersion = 0;
  const stage=document.createElement('div');stage.id='conversationStage';stage.setAttribute('aria-label','Pinned conversations');
  stage.innerHTML=`<div id="stageShelf" hidden><button id="stagePrevious" class="stage-page" aria-label="Previous pinned conversations">${ic('up')}</button><div id="stageItems"></div><button id="stageNext" class="stage-page" aria-label="More pinned conversations">${ic('down')}</button><button id="stageAdd" class="stage-add" aria-label="Pin a conversation" title="Pin a conversation">${ic('plus')}</button></div><button id="stageToggle" aria-label="Pinned conversations" aria-expanded="false" aria-controls="stageShelf">${ic('chat')}<span id="stageCount" hidden></span></button>`;
  // Keep this at the viewport root: a transformed chat modal changes the
  // containing block of fixed descendants, making the dock jump or clip.
  document.body.append(stage);
  let stagePins=[],stageRecent=[],recentDismissed=[],stageMode='pinned',showDismissedRecents=false,stageSignature='',stageCloseTimer,stageExpanded=false,stagePage=0,stageMotion=0,stageAnimations=[];
  try{const saved=JSON.parse(localStorage.getItem('x056_stage_pins')||'[]');if(Array.isArray(saved))stagePins=[...new Set(saved.filter(x=>typeof x==='string'))];}catch{}
  try{stageMode=localStorage.getItem('x056_stage_mode')==='recent'?'recent':'pinned';for(const [key,set] of [['x056_stage_recent',v=>stageRecent=v],['x056_recent_dismissed',v=>recentDismissed=v]]){const value=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(value))set(value.filter(x=>typeof x==='string'));}}catch{}
  document.body.dataset.stageMode=stageMode;
  function saveRecents(){try{localStorage.setItem('x056_stage_recent',JSON.stringify(stageRecent.slice(0,30)));localStorage.setItem('x056_recent_dismissed',JSON.stringify(recentDismissed));}catch{toast('This browser could not save recent conversations.');}}
  function rememberStage(){const state=engine.state();if(!state.sessionId)return;const id=stageKey(state.projectId,state.sessionId);stageRecent=[id,...stageRecent.filter(x=>x!==id)].slice(0,30);recentDismissed=recentDismissed.filter(x=>x!==id);saveRecents();renderStage();}
  function dismissRecent(project,session){const id=stageKey(project,session);recentDismissed=[...new Set([...recentDismissed,id])];saveRecents();renderStage();refresh();toast('Conversation dismissed from recents.',()=>restoreRecent(project,session));}
  function restoreRecent(project,session){recentDismissed=recentDismissed.filter(x=>x!==stageKey(project,session));saveRecents();renderStage();refresh();}
  function setStageMode(value){stageMode=value==='recent'?'recent':'pinned';stagePage=0;document.body.dataset.stageMode=stageMode;try{localStorage.setItem('x056_stage_mode',stageMode);}catch{toast('This browser could not save the switcher mode.');}renderStage();}
  function stageCandidates(all=cards()){
    const byId=new Map(all.map(x=>[stageKey(x.p.id,x.c.sessionId),x]));
    if(stageMode==='pinned')return stagePins.map(id=>byId.get(id)).filter(Boolean);
    const opened=stageRecent.map(id=>byId.get(id)).filter(Boolean),running=all.filter(x=>['running','background'].includes(x.status));
    const seen=new Set();return [...running,...opened].filter(x=>{const id=stageKey(x.p.id,x.c.sessionId);if(seen.has(id)||recentDismissed.includes(id))return false;seen.add(id);return true;});
  }
  function stageKey(project,session){return project+'::'+session;}
  function isStagePinned(project,session){return stagePins.includes(stageKey(project,session));}
  function saveStage(){try{localStorage.setItem('x056_stage_pins',JSON.stringify(stagePins));}catch{toast('This browser could not save pinned conversations.');}}
  function pinStage(project,session,pinned){
    const id=stageKey(project,session);stagePins=stagePins.filter(x=>x!==id);if(pinned)stagePins.push(id);
    if(pinned){recentDismissed=recentDismissed.filter(x=>x!==id);saveRecents();}saveStage();renderStage();refresh();if(stagePicker.open)renderStagePicker();
  }
  function stageOpen(value){
    clearTimeout(stageCloseTimer);
    if((stage.dataset.expanded==='true')===value){if(value)renderStage();return;}
    const generation=++stageMotion,shelf=$('stageShelf');stageAnimations.forEach(a=>a.cancel());stageAnimations=[];
    if(value){shelf.hidden=false;shelf.inert=false;renderStage();}else shelf.inert=true;
    stage.dataset.expanded=String(value);$('stageToggle').setAttribute('aria-expanded',String(value));updateStageToggle();
    const finish=()=>{if(generation===stageMotion&&!value)shelf.hidden=true;};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
    const origin=$('stageToggle').getBoundingClientRect(),targets=[...shelf.querySelectorAll('.stage-item,.stage-add,.stage-page')].filter(el=>!el.hidden);
    stageAnimations=targets.map((el,index)=>{
      const rect=el.getBoundingClientRect(),fold={transform:`translate(${origin.x+origin.width/2-rect.x-rect.width/2}px,${origin.y+origin.height/2-rect.y-rect.height/2}px) scale(.85)`,opacity:0};
      return el.animate(value?[fold,{transform:'none',opacity:1}]:[{transform:'none',opacity:1},fold],{duration:value?220:160,delay:value?(targets.length-index-1)*14:0,easing:'cubic-bezier(.2,.75,.25,1)',fill:value?'backwards':'forwards'});
    });
    Promise.all(stageAnimations.map(a=>a.finished.catch(()=>{}))).then(finish);
  }
  function updateStageToggle(){
    const count=Number(stage.dataset.count||0),expanded=stage.dataset.expanded==='true';
    $('stageToggle').classList.toggle('stacked',count>1);$('stageToggle').classList.toggle('stacked-many',count>2);
    $('stageToggle').querySelector('use').setAttribute('href',expanded?'#i-down':count?'#i-chat':'#i-plus');
    $('stageCount').hidden=!count||expanded;
  }
  let stageCycle=[],stageCycleIndex=-1,stageCycleAt=0,stageClickQueue=Promise.resolve();
  $('stageToggle').onclick=()=>{
    const candidates=stageCandidates(),byId=new Map(candidates.map(x=>[stageKey(x.p.id,x.c.sessionId),x]));
    if(!candidates.length){openStagePicker();return;}
    const now=Date.now(),state=engine.state(),current=stageKey(state.projectId,state.sessionId);
    if(now-stageCycleAt>1500||!stageCycle.length){
      stageCycle=[...new Set([...stageRecent,...byId.keys()])].filter(id=>byId.has(id));
      stageCycleIndex=mode==='closed'?-1:stageCycle.indexOf(current);
    }
    stageCycleAt=now;
    let target;
    for(let i=0;i<stageCycle.length;i++){stageCycleIndex=(stageCycleIndex+1)%stageCycle.length;target=byId.get(stageCycle[stageCycleIndex]);if(target)break;}
    if(!target)return;
    const button={dataset:{project:target.p.id,session:target.c.sessionId}};
    stageClickQueue=stageClickQueue.then(()=>openConversation(button)).then(()=>$('stageToggle').focus({preventScroll:true}));
  };
  stage.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'&&stageCandidates().length){clearTimeout(stageCloseTimer);stageOpen(true);}});
  stage.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'&&!stageExpanded&&!stage.contains(document.activeElement))stageCloseTimer=setTimeout(()=>stageOpen(false),250);});
  stage.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('stageShelf').hidden){e.preventDefault();e.stopPropagation();stageExpanded=false;stageOpen(false);$('stageToggle').focus();}});
  document.addEventListener('pointerdown',e=>{if(!stage.contains(e.target)){stageExpanded=false;stageOpen(false);}});
  $('stageAdd').onclick=openStagePicker;
  $('stagePrevious').onclick=()=>{stagePage=Math.max(0,stagePage-1);renderStage();};
  $('stageNext').onclick=()=>{stagePage++;renderStage();};
  window.addEventListener('resize',()=>{renderStage();if(innerWidth<=850){stageExpanded=false;stageOpen(false);}});
  window.addEventListener('storage',e=>{
    if(e.key==='x056_stage_mode'){stageMode=e.newValue==='recent'?'recent':'pinned';document.body.dataset.stageMode=stageMode;stagePage=0;renderStage();return;}
    const assign={'x056_stage_pins':v=>stagePins=v,'x056_stage_recent':v=>stageRecent=v,'x056_recent_dismissed':v=>recentDismissed=v};if(!assign[e.key])return;
    try{const value=JSON.parse(e.newValue||'[]');if(Array.isArray(value)){assign[e.key]([...new Set(value.filter(x=>typeof x==='string'))]);renderStage();refresh();}}catch{}
  });
  function renderStage(){
    const all=cards(),s=engine.state(),byId=new Map(all.map(x=>[stageKey(x.p.id,x.c.sessionId),x]));
    const pinned=stageCandidates(all),pageSize=Math.max(1,Math.min(7,Math.floor((innerHeight-230)/58)));
    stagePage=Math.min(stagePage,Math.max(0,Math.ceil(pinned.length/pageSize)-1));
    const rows=pinned.slice(stagePage*pageSize,(stagePage+1)*pageSize);
    $('stageCount').textContent=pinned.length||'';$('stageCount').hidden=!pinned.length;
    $('stageToggle').setAttribute('aria-label',pinned.length?(stageMode==='pinned'?'Pinned conversations':'Recent conversations')+' ('+pinned.length+') · Click to switch, hover to browse':'Pin a conversation');
    stage.setAttribute('aria-label',stageMode==='pinned'?'Pinned conversations':'Recent conversations');
    stage.dataset.count=String(pinned.length);updateStageToggle();
    $('stagePrevious').setAttribute('aria-label','Previous conversations');$('stageNext').setAttribute('aria-label','More conversations');
    $('stagePrevious').hidden=stagePage===0;$('stageNext').hidden=(stagePage+1)*pageSize>=pinned.length;
    const html=rows.map(x=>{const title=x.c.title||'Conversation',current=x.c.sessionId===s.sessionId&&x.p.id===s.projectId;return `<div class="stage-item ${current?'current':''}"><button class="stage-conversation ${x.status}" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}" aria-label="${esc(title+' · '+x.p.name+' · '+(statusLabels[x.status]||'Idle'))}" ${current?'aria-current="true"':''} style="--project-color:${projectColor(x.p.id)}"><span class="stage-caption"><strong>${esc(title)}</strong><small>${esc(x.p.name)} · ${statusLabels[x.status]||'Idle'}</small></span>${ic(['running','background'].includes(x.status)?'sparkles':'chat')}<i class="stage-status" aria-hidden="true"></i></button><button class="stage-unpin" data-stage-unpin="${esc(stageKey(x.p.id,x.c.sessionId))}" aria-label="${stageMode==='pinned'?'Unpin':'Dismiss'} ${esc(title)}">${ic('x')}</button></div>`;}).join('');
    if(html===stageSignature)return;stageSignature=html;const focused=document.activeElement,focus=focused?.dataset.session,unpinFocus=focused?.dataset.stageUnpin;$('stageItems').innerHTML=html;
    $('stageItems').querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>openConversation(b));
    $('stageItems').querySelectorAll('[data-stage-unpin]').forEach(b=>b.onclick=()=>{const x=byId.get(b.dataset.stageUnpin);if(x){if(stageMode==='pinned')pinStage(x.p.id,x.c.sessionId,false);else dismissRecent(x.p.id,x.c.sessionId);}$('stageToggle').focus();});
    if(focus)[...$('stageItems').querySelectorAll('[data-session]')].find(b=>b.dataset.session===focus)?.focus({preventScroll:true});
    if(unpinFocus)[...$('stageItems').querySelectorAll('[data-stage-unpin]')].find(b=>b.dataset.stageUnpin===unpinFocus)?.focus({preventScroll:true});
  }
  const stagePicker=document.createElement('dialog');stagePicker.id='stagePinPicker';stagePicker.className='cr-dialog';stagePicker.setAttribute('aria-label','Pin conversations');
  stagePicker.innerHTML=`<header><div><h2>Pin conversations</h2><p>Keep your shortcuts here. Saved on this browser.</p></div><button class="cr-icon" data-pin-close aria-label="Close pin picker">${ic('x')}</button></header><label class="cr-search">${ic('search')}<input id="stagePinSearch" type="search" placeholder="Find a conversation or project" aria-label="Find conversation to pin"></label><div id="stagePinChoices"></div><footer><span id="stagePinTotal"></span><button class="cr-primary" data-pin-done>Done</button></footer>`;
  document.body.append(stagePicker);stagePicker.querySelector('[data-pin-close]').onclick=()=>stagePicker.close();stagePicker.querySelector('[data-pin-done]').onclick=()=>stagePicker.close();$('stagePinSearch').oninput=()=>{stagePickerLimit=30;renderStagePicker();};
  let stagePickerLimit=30;
  function openStagePicker(){stageExpanded=false;stageOpen(false);stagePickerLimit=30;$('stagePinSearch').value='';renderStagePicker();if(!stagePicker.open)stagePicker.showModal();$('stagePinSearch').focus();}
  function renderStagePicker(){
    const query=$('stagePinSearch').value.trim().toLowerCase(),all=cards().filter(x=>[x.p.name,x.c.title].join(' ').toLowerCase().includes(query));
    const focus=document.activeElement?.dataset.pinChoice;
    $('stagePinTotal').textContent=stagePins.length+' pinned';
    $('stagePinChoices').innerHTML=all.slice(0,stagePickerLimit).map(x=>`<label class="stage-pin-choice"><i class="cr-project-color" style="--project-color:${projectColor(x.p.id)}"></i><span><strong>${esc(x.c.title||'Conversation')}</strong><small>${esc(x.p.name)}</small></span><input type="checkbox" data-pin-choice="${esc(stageKey(x.p.id,x.c.sessionId))}" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}" aria-label="Pin ${esc(x.c.title||'conversation')}" ${isStagePinned(x.p.id,x.c.sessionId)?'checked':''}></label>`).join('')||'<p class="cr-empty">No matching conversations.</p>';
    if(all.length>stagePickerLimit)$('stagePinChoices').insertAdjacentHTML('beforeend','<button class="cr-text-button" id="stageMoreChoices">Show more conversations</button>');
    $('stagePinChoices').querySelectorAll('[data-pin-choice]').forEach(input=>input.onchange=()=>pinStage(input.dataset.project,input.dataset.session,input.checked));
    if(focus)[...$('stagePinChoices').querySelectorAll('[data-pin-choice]')].find(b=>b.dataset.pinChoice===focus)?.focus({preventScroll:true});
    if($('stageMoreChoices'))$('stageMoreChoices').onclick=()=>{stagePickerLimit+=30;renderStagePicker();};
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
  function toast(message,undo) { const dialogs=[...document.querySelectorAll('dialog[open]')];(dialogs[dialogs.length-1]||(mode==='closed'?shell:main)).append(toastElement);toastElement.textContent=message;if(undo){const button=document.createElement('button');button.className='toast-undo';button.textContent='Undo';button.onclick=()=>{undo();toastElement.hidden=true;};toastElement.append(button);}toastElement.hidden=false;clearTimeout(accountTimer);accountTimer=setTimeout(()=>toastElement.hidden=true,6000); }
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
    $('chatMax').title = $('chatMax').ariaLabel = mode === 'side' ? 'Open large modal' : mode === 'modal' ? 'Open full screen' : 'Return to large modal';
    if (mode !== 'closed') restorePosition();
    if(mode==='modal')main.setAttribute('aria-owns','conversationStage');else main.removeAttribute('aria-owns');
  }
  function open(remember = true) { if(remember)rememberStage(); if (mode === 'closed') { returnFocus = document.activeElement; setMode(prefs.open === 'side' ? 'side' : prefs.maximize); requestAnimationFrame(() => $('chatClose').focus()); } updateTitle(); }
  function close() { engine.closePops(); engine.nav(false); setMode('closed'); if (returnFocus?.isConnected) returnFocus.focus(); else $('crBoardTab').focus(); }
  function pageFor(name) { return $('cr'+({board:'Board',accounts:'Accounts',automations:'Automations',artifacts:'Artifacts',planner:'Planner'}[name])); }
  function showSection(next) {
    sectionScroll[section] = pageFor(section).scrollTop;
    close(); engine.nav(false); section = next; projectNav(false);
    ['board','accounts','automations','artifacts','planner'].forEach(name=>pageFor(name).hidden=name!==next);
    ['Board','Accounts','Automations','Artifacts','Planner'].forEach(name=>$('cr'+name+'Tab').setAttribute('aria-current',next===name.toLowerCase()?'page':'false'));
    $('crBreadcrumb').innerHTML='Workspace <span>/ '+({board:'Control room',accounts:'Dashboard',automations:'Automations',artifacts:'Artifact library',planner:'Queue planner'}[next])+'</span>';
    if(next==='accounts') { renderAccountsPage(); renderProjectCosts(); loadProjectCosts(); loadAnalytics(); engine.pollAccounts(); }
    else if(next==='automations') { $('cronBtn').click(); loadAutomationAutopilots(); }
    else if(next==='artifacts'){$('artifactProject').innerHTML=workspaceProjectOptions();loadArtifacts();}
    else if(next==='planner'){$('plannerProject').innerHTML=workspaceProjectOptions();loadPlanner();}
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
  on('crAutomationsTab',()=>showSection('automations')); on('refreshAutomations',()=> { $('cronBtn').click(); loadAutomationAutopilots(); }); on('crNotifications',e=>notificationMenu(e.currentTarget)); on('chatActivity',e=>activityMenu(e.currentTarget)); on('focusSearch', () => $('searchChatsBtn').click());
  ['crNew','focusNew'].forEach(id => on(id, () => { engine.newConversation(selectedProject); open(); }));
  on('chatRefresh', async e => {
    const button=e.currentTarget;button.disabled=true;button.setAttribute('aria-busy','true');rememberPosition();
    try {await engine.refreshConversation();restorePosition();refresh();toast('Conversation refreshed.');}
    catch(err){toast('Could not refresh. '+err.message);}
    finally{button.disabled=false;button.removeAttribute('aria-busy');}
  });
  on('chatClose', close); on('chatMax', () => setMode(mode === 'side' ? 'modal' : mode === 'modal' ? 'page' : 'modal'));
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
    if (e.key === 'Tab' && mode === 'modal') { const nodes = [...main.querySelectorAll('button,input,textarea,select,[tabindex="0"],a[href]'),...stage.querySelectorAll('button')].filter(n => n.offsetParent && !n.disabled && !n.hidden); const first = nodes[0], last = nodes[nodes.length-1]; if (e.shiftKey && (document.activeElement === first || (!main.contains(document.activeElement)&&!stage.contains(document.activeElement)))) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
  });
  function updateTitle() { const s = engine.state(), p = s.projects.find(p => p.id === s.projectId), c = p?.conversations?.find(c => c.sessionId === s.sessionId); main.setAttribute('aria-label', c?.title || 'New conversation'); if (c) $('projTitle').textContent = c.title; $('projTitle').disabled=!c; $('projTitle').title=c?'Rename conversation':'New conversation'; }
  function cards() {
    const s = engine.state(), out = [];
    for (const p of s.projects) for (const c of p.conversations || []) {
      const k = p.id + '::' + c.sessionId, q = s.questions[c.sessionId], result = outcomes.get(k) || (c.lastOutcome && { ...c.lastOutcome, ts:c.lastOutcome.at });
      const running = !!s.running[p.id]?.[c.sessionId], bg = !running && !!s.background[p.id]?.[c.sessionId];
      if(c.lastMessageAt!==undefined)messageMetadata.set(k,Number(c.lastMessageAt)||0);
      const notification = s.notifications[k];
      const status = q ? 'question' : running ? 'running' : bg ? 'background' : result?.status === 'failed' || !result && notification === 'failed' ? 'failed' : result?.status === 'parked' ? 'parked' : result?.status === 'completed' || notification === 'done' ? 'finished' : 'idle';
      out.push({ p, c, k, status, unread: !!notification, label: q?.question || (running || bg ? s.views[k]?.label : result?.reason) || '', time: Math.max(messageMetadata.get(k)||0,messageActivity.get(k)||0) });
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
    const html=`<button class="cr-project-link ${!selectedProject?'selected':''}" data-scope="" aria-current="${!selectedProject?'page':'false'}">${ic('menu')}<span>All projects</span><small>${all.filter(x=>showDismissedProjects||!dismissedProjects.includes(x.p.id)).length}</small></button><div class="cr-project-separator"></div>`+state.projects.filter(p=>(showDismissedProjects||!dismissedProjects.includes(p.id))&&p.name.toLowerCase().includes(query)).map(p=>{
      const rows=all.filter(x=>x.p.id===p.id), attention=rows.filter(x=>['question','failed','parked'].includes(x.status)).length, running=rows.filter(x=>['running','background'].includes(x.status)).length;
      return `<button class="cr-project-link ${p.id===selectedProject?'selected':''} ${dismissedProjects.includes(p.id)?'dismissed':''}" data-scope="${esc(p.id)}" aria-current="${p.id===selectedProject?'page':'false'}" title="${esc(p.name)}${dismissedProjects.includes(p.id)?' · Dismissed':''}"><i class="cr-project-color" style="--project-color:${projectColor(p.id)}"></i><span>${esc(p.name)}</span>${attention?`<small class="attention" title="${attention} need attention">${attention}</small>`:running?`<small class="working" title="${running} running">${running}</small>`:`<small>${rows.length}</small>`}</button>`;
    }).join('');
    const hiddenCount=state.projects.filter(p=>dismissedProjects.includes(p.id)).length;
    const markup=html+(hiddenCount?`<button id="crDismissedProjects" class="cr-text-button">${showDismissedProjects?'Hide dismissed projects':'Show dismissed projects'} (${hiddenCount})</button>`:'');
    if(markup!==projectNavSignature){projectNavSignature=markup;$('crProjectLinks').innerHTML=markup;$('crProjectLinks').querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>selectProjectScope(b.dataset.scope));if($('crDismissedProjects'))$('crDismissedProjects').onclick=()=>{showDismissedProjects=!showDismissedProjects;refresh();};}
  }
  function relativeDate(value) { if(!value)return '—';const d=new Date(value), elapsed=Date.now()-d.getTime();if(isNaN(d))return '';if(elapsed<60000)return 'Just now';if(elapsed<3600000)return Math.floor(elapsed/60000)+'m ago';if(elapsed<86400000)return Math.floor(elapsed/3600000)+'h ago';return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
  async function openConversation(button) {
    button.disabled=true;
    try {rememberPosition();await engine.select(button.dataset.project,button.dataset.session);engine.markRead();open();restorePosition();renderSendAccounts();}
    catch(e){toast(e.message);}finally{if(button.isConnected)button.disabled=false;}
  }
  function conversationRow(x) {
    return `<article class="cr-conversation-row ${x.status}" data-row="${esc(x.c.sessionId)}">${bulkMode?`<input class="bulk-checkbox" type="checkbox" data-bulk-key="${esc(x.k)}" aria-label="Select ${esc(x.c.title||'conversation')}" ${bulkSelection.has(x.k)?'checked':''}>`:''}<button class="cr-task" data-project="${esc(x.p.id)}" data-session="${esc(x.c.sessionId)}"><i class="cr-project-color" style="--project-color:${projectColor(x.p.id)}"></i><span class="cr-row-copy"><span class="cr-row-title">${esc(x.c.title||'Conversation')}<small class="cr-row-tags">${esc((conversationMeta[x.k]?.tags||[]).join(' · '))}</small>${x.unread?'<i class="cr-unread-dot" title="Unread"></i>':''}</span><span class="cr-row-subtitle">${esc(selectedProject ? (x.label || (x.c.provider==='codex'?'ChatGPT':'Claude')) : x.p.name+(x.label?' · '+x.label:''))}</span></span><span class="cr-status ${x.status}"><i></i>${statusLabels[x.status]}</span><time ${x.time?'datetime="'+new Date(x.time).toISOString()+'" title="Last message: '+esc(new Date(x.time).toLocaleString())+'"':'title="No message timestamp available"'}>${esc(relativeDate(x.time))}</time></button><button class="cr-row-menu cr-icon" data-conversation-menu="${esc(x.c.sessionId)}" data-project="${esc(x.p.id)}" aria-label="Actions for ${esc(x.c.title||'conversation')}">${ic('more')}</button><button class="cr-row-pin ${isStagePinned(x.p.id,x.c.sessionId)?'pinned':''}" data-pin-project="${esc(x.p.id)}" data-pin-session="${esc(x.c.sessionId)}" aria-label="${isStagePinned(x.p.id,x.c.sessionId)?'Unpin':'Pin'} ${esc(x.c.title||'conversation')}" aria-pressed="${isStagePinned(x.p.id,x.c.sessionId)}">${ic('pin')}</button>${['finished','idle'].includes(x.status)?`<button class="cr-recent-dismiss" data-recent-project="${esc(x.p.id)}" data-recent-session="${esc(x.c.sessionId)}" aria-label="${recentDismissed.includes(stageKey(x.p.id,x.c.sessionId))?'Restore':'Dismiss'} ${esc(x.c.title||'conversation')} ${recentDismissed.includes(stageKey(x.p.id,x.c.sessionId))?'to':'from'} recents" title="${recentDismissed.includes(stageKey(x.p.id,x.c.sessionId))?'Restore to recents':'Dismiss from recents'}">${ic(recentDismissed.includes(stageKey(x.p.id,x.c.sessionId))?'history':'x')}</button>`:''}${x.status==='question'?`<button class="cr-dismiss" data-dismiss="${esc(x.c.sessionId)}" data-project="${esc(x.p.id)}" title="Dismiss question without sending a reply">Dismiss question</button>`:''}</article>`;
  }
  function renderBoard() {
    const all=cards(),state=engine.state();
    if(selectedProject&&!state.projects.some(p=>p.id===selectedProject)&&state.projects.length)selectedProject='';
    const scope=all.filter(x=>(boardFilter==='archived'?conversationMeta[x.k]?.archived:!conversationMeta[x.k]?.archived)&&(showDismissedProjects||!dismissedProjects.includes(x.p.id))&&(!selectedProject||x.p.id===selectedProject)),project=state.projects.find(p=>p.id===selectedProject);
    $('crScopeActions').hidden=!project;
    $('crScopeTitle').textContent=project?.name||'All projects';
    $('crScopeSubtitle').textContent=scope.length+' conversations'+(project?'':' across '+state.projects.filter(p=>showDismissedProjects||!dismissedProjects.includes(p.id)).length+' projects');
    $('crStats').innerHTML=[[scope.filter(x=>['running','background'].includes(x.status)).length,'Running'],[scope.filter(x=>x.status==='question').length,'Needs input'],[scope.filter(x=>x.unread).length,'Unread']].map(([n,t])=>`<div><strong>${n}</strong><span>${t}</span></div>`).join('');
    renderProjectNav(all,state);
    const selector=$('crProjectFilter');selector.innerHTML='<option value="">All projects</option>'+state.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');selector.value=selectedProject;
    const query=$('crSearch').value.toLowerCase();
    const filtered=scope.filter(x=>(!query||(x.c.title+' '+x.p.name+' '+x.label+' '+(conversationMeta[x.k]?.tags||[]).join(' ')).toLowerCase().includes(query))&&(boardFilter==='all'||boardFilter==='archived'||boardFilter==='question'&&x.status==='question'||boardFilter==='unread'&&x.unread||boardFilter==='active'&&['running','background'].includes(x.status)));

    const unread=filtered.filter(x=>x.unread),attention=filtered.filter(x=>!x.unread&&['question','failed','parked'].includes(x.status)),active=filtered.filter(x=>!x.unread&&['running','background'].includes(x.status)),recent=filtered.filter(x=>!x.unread&&['finished','idle'].includes(x.status)&&(!recentDismissed.includes(stageKey(x.p.id,x.c.sessionId))||query||showDismissedRecents||boardFilter!=='all'));
    const dismissedCount=scope.filter(x=>['finished','idle'].includes(x.status)&&recentDismissed.includes(stageKey(x.p.id,x.c.sessionId))).length;
    bulkCandidates=[...unread,...attention,...active,...recent];renderBulk();
    const groups=[['Unread',unread],['Needs attention',attention],['In progress',active],['Recent conversations',recent.slice(0,recentLimit)]];
    let html=groups.filter(([,rows])=>rows.length).map(([title,rows])=>`<section class="cr-conversation-group"><header><h2>${title}</h2><span>${title==='Recent conversations'?recent.length:rows.length}</span></header>${rows.map(conversationRow).join('')}</section>`).join('');
    if(!html)html=`<div class="cr-empty">${query?'No conversations match your search.':boardFilter==='question'?'No questions need your input.':'No conversations in this view.'}</div>`;
    if(recent.length>recentLimit)html+=`<button class="cr-load-more" id="crShowMore">Show ${Math.min(20,recent.length-recentLimit)} more conversations <span>${recent.length-recentLimit} remaining</span></button>`;
    if(dismissedCount&&boardFilter==='all'&&!query)html+=`<button id="crDismissedRecents" class="cr-text-button cr-dismissed-toggle">${showDismissedRecents?'Hide dismissed':'Show dismissed'} (${dismissedCount})</button>`;
    if(html!==boardSignature){
      boardSignature=html;
      const focused=document.activeElement?.closest('.cr-conversation-row')?.dataset.row,moreFocused=document.activeElement?.id==='crShowMore';
      $('crLanes').innerHTML=html;
      if(focused)([...$('crLanes').querySelectorAll('.cr-task')].find(n=>n.dataset.session===focused)||shell.querySelector('[data-filter="question"]')).focus({preventScroll:true});
      if(moreFocused)($('crShowMore')||$('crLanes').querySelector('.cr-task:last-child'))?.focus({preventScroll:true});
      $('crLanes').querySelectorAll('[data-bulk-key]').forEach(box=>box.onchange=()=>{box.checked?bulkSelection.add(box.dataset.bulkKey):bulkSelection.delete(box.dataset.bulkKey);renderBulk();});
      $('crLanes').querySelectorAll('.cr-task').forEach(b=>b.onclick=()=>openConversation(b));
      $('crLanes').querySelectorAll('[data-recent-session]').forEach(b=>b.onclick=()=>{const pid=b.dataset.recentProject,sid=b.dataset.recentSession;if(recentDismissed.includes(stageKey(pid,sid)))restoreRecent(pid,sid);else dismissRecent(pid,sid);});
      if($('crDismissedRecents'))$('crDismissedRecents').onclick=()=>{showDismissedRecents=!showDismissedRecents;renderBoard();};
      $('crLanes').querySelectorAll('[data-pin-session]').forEach(b=>b.onclick=()=>pinStage(b.dataset.pinProject,b.dataset.pinSession,!isStagePinned(b.dataset.pinProject,b.dataset.pinSession)));
      $('crLanes').querySelectorAll('[data-dismiss]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await engine.dismissQuestion(b.dataset.project,b.dataset.dismiss);toast('Question dismissed. No reply sent.');refresh();}catch(e){toast(e.message);b.disabled=false;}});
      if($('crShowMore'))$('crShowMore').onclick=()=>{recentLimit+=20;renderBoard();};
    }
    updateTitle();renderSendAccounts();if(section==='accounts'){renderProjectCosts();loadProjectCosts();}renderRuns();renderStage();
  }
  let costSnapshot=null,costError='',costBusy=false,costUpdated=0,costSignature='';
  const costDialog=document.createElement('dialog');costDialog.className='cr-dialog';costDialog.id='projectCostDetails';costDialog.setAttribute('aria-label','Project cost estimates');document.body.append(costDialog);
  const fxReference={rate:17653,date:'7 September 2026',source:'https://www.bi.go.id/en/statistik/informasi-kurs/jisdor/Default.aspx'};
  const rupiah=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format((n||0)*fxReference.rate);
  const money=n=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n||0);
  function costRows(){return costSnapshot?.projects||[];}
  function renderProjectCosts(){
    if(!$('crProjectCosts'))return;
    const rows=costRows(),usd=rows.reduce((n,p)=>n+p.cost.usd,0),tokens=rows.reduce((n,p)=>n+p.usage.input+p.usage.output+p.usage.cacheRead+p.usage.cacheWrite,0);
    const partial=rows.some(p=>p.partial),unknown=[...new Set(rows.flatMap(p=>p.cost.unpriced))],missing=rows.reduce((n,p)=>n+p.missing,0);
    const markup=`<div><span class="cr-eyebrow">PROJECT COST ESTIMATE</span><div class="cr-cost-value">${costSnapshot?'≈ '+money(usd):'—'}${costSnapshot?'<span class="cr-cost-idr">≈ '+rupiah(usd)+'</span>':''}<small>${costSnapshot?compact(tokens)+' recorded tokens':'Loading recorded usage…'}</small></div><p>${costError?esc(costError):partial?'Scanning transcripts · totals are still updating':unknown.length?'Some models are unpriced':missing?'Some conversations have no recorded usage':'At standard API rates · includes subagents'}</p></div><button class="cr-secondary" id="crCostDetails">${costError?'Retry':'View breakdown'} ${ic('right')}</button>`;
    if(markup===costSignature)return;costSignature=markup;$('crProjectCosts').innerHTML=markup;
    $('crCostDetails').onclick=()=>{if(costError){loadProjectCosts(true);return;}renderCostDetails();costDialog.showModal();};
  }
  function renderCostDetails(){
    const rows=costRows(),max=Math.max(0.01,...rows.map(p=>p.cost.usd));
    const scrollTop=costDialog.querySelector('.cost-breakdown')?.scrollTop||0, expanded=new Set([...costDialog.querySelectorAll('details[open]')].map(d=>d.dataset.project));
    costDialog.innerHTML=`<header><div><h2>Project cost estimates</h2><p>All projects · Recorded usage</p></div><button class="cr-icon" data-cost-close aria-label="Close cost breakdown">${ic('x')}</button></header><div class="cost-breakdown">${rows.map(p=>`<details class="cost-project" data-project="${esc(p.projectId)}" ${expanded.has(p.projectId)?'open':''}><summary><span><strong>${esc(p.projectName)}</strong><small>${p.conversations} conversations · ${p.agentCount} agents${p.partial?' · Updating':''}${p.missing?' · Missing transcripts':''}</small></span><strong>≈ ${money(p.cost.usd)}<small>≈ ${rupiah(p.cost.usd)}</small></strong></summary><div class="cost-bar" role="img" aria-label="${esc(p.projectName)}: ${money(p.cost.usd)}"><i style="width:${p.cost.usd/max*100}%"></i></div><p class="cost-agent-note">Includes ${money(p.agentUsd)} (≈ ${rupiah(p.agentUsd)}) from subagents${p.cost.unpriced.length?' · Unpriced: '+esc(p.cost.unpriced.join(', ')):''}</p><div class="cost-conversations">${(costSnapshot?.conversations||[]).filter(c=>c.projectId===p.projectId).sort((a,b)=>b.cost.usd-a.cost.usd).map(c=>`<div><span>${esc(c.title)}<small>${compact(c.usage.input+c.usage.output+c.usage.cacheRead+c.usage.cacheWrite)} tokens${c.partial?' · Scanning':''}${c.missing?' · No transcript':''}${c.cost.unpriced.length?' · Unpriced usage':''}</small></span><strong>${c.missing&&!c.size?'—':'≈ '+money(c.cost.usd)+'<small>≈ '+rupiah(c.cost.usd)+'</small>'}</strong></div>`).join('')}</div></details>`).join('')||'<p class="cr-empty">No project usage recorded yet.</p>'}</div><footer class="cost-footer"><p><a href="${fxReference.source}" target="_blank" rel="noopener">Bank Indonesia JISDOR</a>: 1 USD = ${rupiah(1)} · ${fxReference.date}. IDR amounts are estimates at this reference rate.<br>${esc(costSnapshot?.pricing?.basis||'Estimates use recorded tokens at standard API rates.')}<br>Rates checked ${esc(costSnapshot?.pricing?.date||'—')}. <a href="https://developers.openai.com/api/docs/models" target="_blank" rel="noopener">OpenAI rates</a> · <a href="https://platform.claude.com/docs/en/about-claude/pricing" target="_blank" rel="noopener">Claude rates</a></p><button class="cr-secondary" data-cost-refresh ${costBusy?'disabled':''}>Refresh</button></footer>`;
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
  function accountStatus(a) { return a.paused?'Paused':a.state?.kind==='unauthenticated'?'Needs login':accountQuotaLimited(a)||a.state?.kind==='limited'?'Limited':a.state?.kind==='ok'?'Available':'Not checked'; }
  function identity(a) { return `<span class="cr-account-avatar ${esc(a.provider)}">${a.provider==='codex'?'G':'C'}</span><span class="identity-copy"><strong>${esc(accountName(a))}</strong><small>${esc(a.email || providerName(a.provider))}</small></span>`; }
  function renderSendAccounts(force=false) {
    const s=engine.state(), pool=s.accounts.filter(a=>a.provider===s.provider), preview=routeCache.get(routeKey(s)), chosen=s.sessionId?preview?.selected:s.composerAccount, next=chosen?pool.find(a=>a.name===chosen):preview?null:pool.find(a=>a.nextUp&&available(a));
    loadRoutePreview(s);
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
        <div class="picker-status">${esc(accountStatus(a))}${a.name===next?.name?' · Next message':''}${isRunning&&a.name===s.runningAccount?' · Running this turn':''}</div>
        <div class="picker-quotas">${quotaCell(a,quotaWindows(a).five,'5-hour window')}${quotaCell(a,quotaWindows(a).seven,'7-day window')}</div>
        ${quotaWindows(a).other.length?`<details class="picker-extra"><summary>${quotaWindows(a).other.length} additional usage ${quotaWindows(a).other.length===1?'limit':'limits'}</summary><div class="picker-quotas">${quotaWindows(a).other.map(w=>quotaCell(a,w,w.label)).join('')}</div></details>`:''}
        ${quotaFreshness(a)}</label>`).join('')||'<div class="cr-empty">No accounts connected for this provider.</div>'}</div>
      <p class="picker-note">This choice applies to this conversation’s next turn. If unavailable, automatic routing may use a fallback. Use an account lock to prevent that. ${isRunning?'Use “Switch this turn” to resume the current turn on another account.':''}</p>
      <div id="pickerError" class="cr-error" role="alert"></div><footer><button class="cr-text-button" data-manage-accounts>Routing & locks</button><span class="sp"></span>${isRunning?`<button class="cr-secondary" data-switch-turn ${!selectedSendAccount||selectedSendAccount===s.runningAccount?'disabled':''}>Switch this turn</button>`:''}<button class="cr-primary" data-send-next ${selectedSendAccount?'':'disabled'}>Use for next message</button></footer>`;
    if(html===sendAccountSignature&&!force)return;
    sendAccountSignature=html;
    const focused=document.activeElement, focusValue=focused?.name==='send-account'?focused.value:null, oldScroll=sendAccounts.querySelector('.send-account-list')?.scrollTop||0;
    sendAccounts.innerHTML=html;
    sendAccounts.querySelector('.send-account-list').scrollTop=oldScroll;
    if(focusValue) [...sendAccounts.querySelectorAll('input')].find(n=>n.value===focusValue)?.focus({preventScroll:true});
    sendAccounts.querySelector('[data-close]').onclick=()=>sendAccounts.close();
    sendAccounts.querySelector('[data-manage-accounts]').onclick=()=>{sendAccounts.close();if(s.sessionId)showRouting(s);else showSection('accounts');};
    sendAccounts.querySelectorAll('[name="send-account"]').forEach(input=>input.onchange=()=>{selectedSendAccount=input.value;renderSendAccounts(true);});
    const choose=async(switching)=>{
      // Recheck current state: this dialog may have stayed open across a completed turn.
      const state=engine.state(), selected=state.accounts.find(a=>a.name===selectedSendAccount&&a.provider===s.provider);
      if(!selected||!available(selected)||state.provider!==s.provider) { renderSendAccounts(true);return; }
      let failure='';pickerBusy=true; sendAccounts.querySelectorAll('button,input').forEach(b=>b.disabled=true);
      try {
        if(switching)await json('/api/switch',{projectId:s.projectId,sessionId:s.sessionId,account:selected.name});
        else if(s.sessionId)await json('/api/routing/conversation',{projectId:s.projectId,sessionId:s.sessionId,nextAccount:selected.name});
        else engine.setComposerAccount(selected.name);
        routeCache.delete(routeKey(s));await loadRoutePreview(s,true);
        await engine.pollAccounts(); sendAccounts.close(); toast(switching?'Switching this turn to '+accountName(selected)+'…':'Next turn prefers '+accountName(selected)+'.');
      } catch(e) { failure=e.message; }
      finally {pickerBusy=false;renderSendAccounts(true);if(failure)$('pickerError').textContent=failure;}
    };
    sendAccounts.querySelector('[data-send-next]').onclick=()=>choose(false);
    const switchButton=sendAccounts.querySelector('[data-switch-turn]');if(switchButton)switchButton.onclick=()=>choose(true);
  }
  function refresh() { clearTimeout(renderTimer); renderTimer = setTimeout(() => { renderBoard(); if (section === 'accounts') renderAccountRows(); }, 60); }
  async function json(url, body) { const res = await engine.api(url, body === undefined ? undefined : { method:'POST', body:JSON.stringify(body) }); const data = await res.json(); if (!res.ok) throw new Error(data.message || 'Request failed'); return data; }
  function event(kind, data) {
    if(kind==='assistant_text'&&data.projectId&&data.sessionId)messageActivity.set(data.projectId+'::'+data.sessionId,Date.parse(data.ts)||Date.now());
    if (['session_done','session_error','turn_orphaned'].includes(kind)) outcomes.set(data.projectId + '::' + data.sessionId, { status:kind === 'session_done' ? data.status : 'failed', reason:data.reason || data.message, ts:data.ts || Date.now() });
    if (kind === 'session_started') outcomes.delete(data.projectId + '::' + data.sessionId);
    refresh();
    if(section==='automations'&&['autopilot','session_started','session_done','session_error','project_removed'].includes(kind))loadAutomationAutopilots();
    if (section === 'accounts' && ['session_done','accounts'].includes(kind)) loadAnalytics();
    if (section==='planner'&&kind==='queue')loadPlanner();
  }
  let automationBusy=false,automationAgain=false;
  async function loadAutomationAutopilots(){
    if(automationBusy){automationAgain=true;return;}automationBusy=true;
    const host=$('automationAutopilots');
    try{
      const data=await json('/api/autopilot'),projects=engine.state().projects,all=cards();
      host.innerHTML='<header class="automation-section-heading"><h2>Conversation autopilots</h2><span>'+Object.keys(data).length+' enabled</span></header>'+Object.entries(data).map(([sid,ap])=>{
        const project=projects.find(p=>p.id===ap.projectId),conversation=project?.conversations?.find(c=>c.sessionId===sid),card=all.find(x=>x.c.sessionId===sid&&x.p.id===ap.projectId),status=card&&['running','background'].includes(card.status)?'Running':'Waiting for next turn';
        return `<article class="automation-ap-row"><button class="automation-ap-open" data-project="${esc(ap.projectId)}" data-session="${esc(sid)}" ${!conversation?'disabled':''}><i class="cr-project-color" style="--project-color:${projectColor(ap.projectId)}"></i><span><strong>${esc(conversation?.title||'Conversation unavailable')}</strong><small>${esc(project?.name||'Project unavailable')} · ${status}</small></span></button><span class="automation-ap-remaining">${ap.remaining} continuations left</span><button class="cr-secondary" data-stop-ap="${esc(sid)}">Stop autopilot</button></article>`;
      }).join('')+(Object.keys(data).length?'':'<p class="cr-empty">No conversation autopilots enabled. Open a conversation to enable autopilot from its menu.</p>');
      host.querySelectorAll('[data-session]').forEach(b=>b.onclick=()=>openConversation(b));
      host.querySelectorAll('[data-stop-ap]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await json('/api/autopilot/stop',{sessionId:b.dataset.stopAp});toast('Autopilot stopped. The current turn can finish.');await loadAutomationAutopilots();}catch(e){toast(e.message);b.disabled=false;}});
    }catch(e){host.innerHTML='<header class="automation-section-heading"><h2>Conversation autopilots</h2></header><p class="cr-note" role="status">'+esc(e.message)+' · Use Refresh to retry.</p>';}
    finally{automationBusy=false;if(automationAgain){automationAgain=false;loadAutomationAutopilots();}}
  }
  setInterval(()=>{if(section==='automations'&&!document.hidden)loadAutomationAutopilots();},15000);
  function segmented(id, items, value, label) {
    return `<div id="${id}" class="cr-segments" role="group" aria-label="${label}">${items.map(([v,t])=>`<button data-value="${v}" aria-pressed="${v===value}">${t}</button>`).join('')}</div>`;
  }
  function wireSegment(id, change) { $(id).querySelectorAll('button').forEach(b=>b.onclick=()=>{ $(id).querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));change(b.dataset.value); }); }
  function renderAccountsPage() {
    if ($('accountProvider')) return;
    $('crAccounts').innerHTML=`<div class="cr-heading"><div><h1>Dashboard</h1><p>Account usage, project costs, and routing.</p></div><div class="cr-actions"><button class="cr-secondary" id="accountHealth">${ic('user')} Health & capacity</button><button class="cr-secondary" id="accountExport">${ic('down')} Export CSV</button><button class="cr-primary" id="accountAdd">${ic('plus')} Add account</button></div></div>
      <section id="crProjectCosts" class="cr-project-costs" aria-label="Project cost estimates"></section><div class="cr-tools">${segmented('accountProvider',[['','All providers'],['codex','ChatGPT'],['claude','Claude']],accountProvider,'Provider')}<span class="sp"></span>${segmented('accountDays',[['7','7 days'],['30','30 days']],accountDays,'Usage date range')}<button class="cr-icon" id="accountRefresh" title="Refresh usage" aria-label="Refresh usage">${ic('repeat')}</button></div>
      <div id="accountStatus" role="status" class="cr-note"></div><div id="accountStats" class="cr-stats"></div>
      <div class="cr-charts"><section class="cr-chart-card"><header><h2>Activity over time</h2>${segmented('accountMetric',[['attempts','Attempts'],['tokens','Tokens']],chartMetric,'Chart metric')}</header><div class="chart-legend"><span><i></i>ChatGPT</span><span><i class="claude"></i>Claude</span><small>UTC</small></div><div id="accountChart"></div><div id="accountChartCaption" class="cr-chart-caption" role="status"></div></section><section class="cr-chart-card"><header><h2>Tokens by model</h2><span>Reported usage</span></header><div id="accountModels"></div></section></div>
      <div class="cr-section-head"><h2>Connected accounts <small id="accountCount"></small></h2><span>Live availability · Provider limits</span></div><div id="accountRows"></div><div id="accountRouting"></div><p id="accountCoverage" class="cr-note"></p>`;
    on('accountHealth',()=>showHealth()); on('accountAdd',()=>$('addAcctBtn').click()); on('accountExport',exportCsv);
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
  function accountQuotaLimited(a) {
    if(a.quotaOverrideAt&&a.quotaAt<=a.quotaOverrideAt)return false;
    const q=a.quota,windows=a.provider==='codex'?(q?.windows||[]):[q?.fiveHour,q?.sevenDay];
    return windows.some(w=>{
      if(!w||!Number.isFinite(w.utilization)||w.utilization<(a.provider==='codex'?1:100))return false;
      const reset=typeof w.resetsAt==='number'?w.resetsAt*1000:Date.parse(w.resetsAt);
      return Number.isFinite(reset)?reset>Date.now():Number.isFinite(a.quotaAt)&&Date.now()-a.quotaAt<300000;
    });
  }
  function available(a) {return !a.paused&&!['limited','unauthenticated'].includes(a.state?.kind)&&!accountQuotaLimited(a);}
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
    const p=Math.max(0,Math.min(100,Math.floor(w.utilization*(a.provider==='codex'?100:1))));
    const date=w.resetsAt?new Date(typeof w.resetsAt==='number'?w.resetsAt*1000:w.resetsAt):null;
    if(date&&!isNaN(date)&&date.getTime()<=Date.now())return `<div class="cr-quota quota-missing"><span class="quota-label">${esc(label)}</span><strong>—</strong><small>Window reset · awaiting update</small></div>`;
    return `<div class="cr-quota"><div><span class="quota-label">${esc(label)}</span><strong>${p}%</strong></div><div class="cr-track ${p>=90?'high':''}" role="meter" aria-label="${esc(label)} used" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div><small>${date&&!isNaN(date)?'Resets '+esc(date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})):'Reset time not reported'}</small></div>`;
  }
  function quota(a) {return quotaWindows(a).all.map(w=>quotaCell(a,w,w.label)).join('')+quotaFreshness(a);}
  function renderAccountRows() {
    if(!$('accountRows'))return;
    const list=selectedAccounts();$('accountCount').textContent=list.length;
    const html=`<div class="cr-account-table"><div class="cr-account-head"><span>Account</span><span>Availability</span><span>5-hour window</span><span>7-day window</span><span>Other limits</span><span class="sr-only">Actions</span></div>${list.map(a=>{
      const w=quotaWindows(a);
      return `<article class="cr-account-row"><div><button class="cr-identity identity-button" data-manage="${esc(a.name)}">${identity(a)}</button>${quotaFreshness(a)}</div><div class="account-availability"><span class="cr-account-state ${available(a)?'ready':a.paused?'paused':'limited'}">${esc(accountStatus(a))}</span>${a.nextUp&&available(a)?'<small class="next-badge">Next message</small>':''}</div>${quotaCell(a,w.five,'5-hour window')}${quotaCell(a,w.seven,'7-day window')}<div class="other-quotas">${w.other.length?quotaCell(a,w.other[0],w.other[0].label)+(w.other.length>1?`<button class="cr-text-button" data-manage="${esc(a.name)}">+${w.other.length-1} more limits</button>`:''):quotaCell(a,null,'Other limits')}</div><button class="cr-icon" data-account-menu="${esc(a.name)}" aria-label="Manage ${esc(accountName(a))}">${ic('more')}</button></article>`;
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
      body.innerHTML=`<h3>Appearance</h3><div class="theme-choices">${[['system','auto','Follow device'],['light','sun','Light'],['dark','moon','Dark']].map(([v,i,t])=>`<button data-theme-choice="${v}" aria-pressed="${engine.theme()===v}">${ic(i)}<span>${t}</span></button>`).join('')}</div><section class="stage-settings"><h3>Desktop conversation switcher</h3>${segmented('stageMode',[['pinned','Pinned only'],['recent','Recent chats']],stageMode,'Conversation switcher mode')}<p id="stageModeHelp"></p></section><div id="displayFields"></div><div class="setting-row"><span><strong>Notifications</strong><small>Messages and requests that need your attention</small></span><button class="cr-secondary" id="settingsNotify">Manage</button></div><div class="setting-row"><span><strong>Keyboard shortcuts</strong><small>Navigate and send messages from your keyboard</small></span><button class="cr-secondary" id="settingsShortcuts">View shortcuts</button></div>`;
      const stageHelp=()=>{$('stageModeHelp').textContent=stageMode==='pinned'?'Only chats you pin appear in the bubbles. The separate running indicator stays visible.':'Recent and running chats appear in the bubbles. The separate running indicator is hidden on desktop.';};stageHelp();wireSegment('stageMode',value=>{setStageMode(value);stageHelp();});
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
  document.addEventListener('pointerdown',e=>{if(menu.getAttribute('popover')==='manual'&&menu.matches(':popover-open')&&!menu.contains(e.target))menu.hidePopover();});
  function openMenu(anchor,items,point) {
    if(menu.matches(':popover-open'))menu.hidePopover();
    menu.setAttribute('popover',point?'manual':'auto');
    menuAnchor=anchor; (anchor.closest('dialog')||document.body).append(menu);
    menu.innerHTML=items.map((it,i)=>`<button role="menuitem" data-menu-item="${i}" ${it.disabled?'disabled':''}>${ic(it.icon)}<span>${esc(it.label)}</span>${it.checked?ic('check'):''}</button>`).join('');
    menu.querySelectorAll('button').forEach(b=>b.onclick=()=>{menu.hidePopover();items[Number(b.dataset.menuItem)].run();});
    menu.showPopover();
    const rect=anchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,point?point.x:rect.right-menu.offsetWidth))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,point?point.y:rect.bottom+7))+'px';
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  menu.addEventListener('keydown',e=>{const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();menu.hidePopover();menuAnchor?.focus();}if(e.key==='Tab')menu.hidePopover();});
  function syncTheme(){const name=engine.theme();$('crTheme').innerHTML=ic({system:'auto',light:'sun',dark:'moon'}[name]);$('crTheme').ariaLabel='Appearance: '+(name==='system'?'Follow device theme':name);}
  function setProjectDismissed(id,value){
    dismissedProjects=dismissedProjects.filter(x=>x!==id);if(value)dismissedProjects.push(id);
    try{localStorage.setItem('x056_dismissed_projects',JSON.stringify(dismissedProjects));}catch{toast('This browser could not save dismissed projects.');}
    if(value&&selectedProject===id)selectedProject='';
    try{localStorage.setItem('x056_project_scope',selectedProject);}catch{}
    refresh();toast(value?'Project dismissed.':'Project restored.',()=>setProjectDismissed(id,!value));
  }
  window.addEventListener('storage',e=>{if(e.key!=='x056_dismissed_projects')return;try{const value=JSON.parse(e.newValue||'[]');if(Array.isArray(value)){dismissedProjects=value.filter(x=>typeof x==='string');if(dismissedProjects.includes(selectedProject))selectedProject='';refresh();}}catch{}});
  function projectMenu(anchor,id,point){
    const project=engine.state().projects.find(p=>p.id===id);if(!project)return;
    openMenu(anchor,[{label:'New conversation',icon:'plus',run:()=>engine.newConversation(id)},{label:'Rename project',icon:'compose',run:()=>engine.renameProject(id)},{label:dismissedProjects.includes(id)?'Restore project':'Dismiss project',icon:'x',run:()=>setProjectDismissed(id,!dismissedProjects.includes(id))}],point);
  }
  function rowConversationMenu(anchor,pid,sid,point){
    const s=engine.state(),p=s.projects.find(p=>p.id===pid),c=p?.conversations?.find(c=>c.sessionId===sid);if(!c)return;
    const running=!!s.running[pid]?.[sid],unread=!!s.notifications[stageKey(pid,sid)];
    openMenu(anchor,[
      {label:'Open conversation',icon:'chat',run:()=>openConversation({dataset:{project:pid,session:sid}})},
      {label:'Rename conversation',icon:'compose',run:()=>engine.renameConversation(pid,sid)},
      {label:isStagePinned(pid,sid)?'Unpin conversation':'Pin conversation',icon:'pin',run:()=>pinStage(pid,sid,!isStagePinned(pid,sid))},
      {label:unread?'Mark as read':'Mark as unread',icon:'bell',run:()=>{engine.setConversationUnread(pid,sid,!unread);refresh();}},
      {label:recentDismissed.includes(stageKey(pid,sid))?'Restore to recents':'Dismiss from recents',icon:'history',run:()=>recentDismissed.includes(stageKey(pid,sid))?restoreRecent(pid,sid):dismissRecent(pid,sid)},
      {label:'Conversation results',icon:'file',run:()=>showResults({projectId:pid,sessionId:sid})},{label:'Routing & accounts',icon:'repeat',disabled:!sid,run:()=>showRouting({projectId:pid,sessionId:sid})},{label:'Continue with another provider',icon:'repeat',disabled:!sid,run:()=>showHandoff({projectId:pid,sessionId:sid})},{label:'Message delivery',icon:'chat',run:engine.showDelivery},{label:'Copy conversation ID',icon:'copy',run:()=>navigator.clipboard.writeText(sid).then(()=>toast('Conversation ID copied.')).catch(()=>toast('Could not copy the conversation ID.'))},
      ...(running?[{label:'Stop turn',icon:'x',run:async()=>{try{await json('/api/sessions/current/stop',{projectId:pid,sessionId:sid});toast('Stopping turn.');}catch(e){toast(e.message);}}}]:[]),
      {label:'Remove from panel',icon:'x',disabled:running,run:()=>engine.removeConversation(pid,sid)},
    ],point);
  }
  document.addEventListener('contextmenu',e=>{
    const row=e.target.closest('.cr-task,.stage-conversation,.automation-ap-open,[data-conversation-menu]'),project=e.target.closest('.cr-project-link[data-scope]');
    if(row){e.preventDefault();e.stopPropagation();rowConversationMenu(row,row.dataset.project,row.dataset.session||row.dataset.conversationMenu,{x:e.clientX,y:e.clientY});}
    else if(project?.dataset.scope){e.preventDefault();e.stopPropagation();projectMenu(project,project.dataset.scope,{x:e.clientX,y:e.clientY});}
  });
  document.addEventListener('click',e=>{const button=e.target.closest('[data-conversation-menu]');if(button)rowConversationMenu(button,button.dataset.project,button.dataset.conversationMenu);});
  $('crScopeActions').onclick=e=>projectMenu(e.currentTarget,selectedProject);
  $('projTitle').onclick=()=>engine.renameConversation();
  function themeMenu(anchor){openMenu(anchor,[['system','auto','Follow device theme'],['light','sun','Light'],['dark','moon','Dark']].map(([value,icon,label])=>({label,icon,checked:engine.theme()===value,run:()=>{engine.setTheme(value);syncTheme();}})));}
  function notificationMenu(anchor){const s=engine.state(),count=Object.keys(s.notifications).length;openMenu(anchor,[{label:'Unread conversations'+(count?' · '+count:''),icon:'bell',run:()=>{if(preferences.open)preferences.close();boardFilter='unread';shell.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.filter==='unread'));showSection('board');}},{label:'Message approvals'+($('mcpApprovalsBadge').textContent?' · '+$('mcpApprovalsBadge').textContent:''),icon:'sparkles',run:()=>$('mcpApprovalsBtn').click()},{label:'Browser notifications',icon:'bell',run:()=>$('notifyBtn').click()}]);}
  function activityMenu(anchor){openMenu(anchor,[{label:'Usage & subagents',icon:'sparkles',run:()=>$('subagentsBtn').click()},{label:'Workflow runs',icon:'fanout',disabled:$('wfBtn').hidden,run:()=>$('wfBtn').click()},{label:'Message approvals',icon:'bell',run:()=>$('mcpApprovalsBtn').click()}]);}
  function conversationMenu(anchor){const s=engine.state();openMenu(anchor,[{label:isStagePinned(s.projectId,s.sessionId)?'Unpin conversation':'Pin conversation',icon:'pin',disabled:!s.sessionId,run:()=>{const pinned=!isStagePinned(s.projectId,s.sessionId);pinStage(s.projectId,s.sessionId,pinned);toast(pinned?'Conversation pinned.':'Conversation unpinned.');}},{label:'Rename conversation',icon:'compose',disabled:!s.sessionId,run:engine.renameConversation},{label:'Resume a session',icon:'history',run:()=>$('resumeBtn').click()},{label:'Conversation results',icon:'file',disabled:!s.sessionId,run:()=>showResults()},{label:'Routing & accounts',icon:'repeat',disabled:!s.sessionId,run:()=>showRouting(s)},{label:'Continue with another provider',icon:'repeat',disabled:!s.sessionId,run:()=>showHandoff(s)},{label:'Message delivery',icon:'chat',run:engine.showDelivery},{label:'Copy conversation ID',icon:'copy',disabled:!s.sessionId,run:()=>navigator.clipboard.writeText(s.sessionId).then(()=>toast('Conversation ID copied.')).catch(()=>toast('Could not copy the conversation ID.'))},{label:'Remove from panel',icon:'x',disabled:!s.sessionId||!!s.running[s.projectId]?.[s.sessionId],run:engine.removeConversation}]);}
  const runningLabel=document.createElement('div');runningLabel.id='runningAccountLabel';runningLabel.hidden=true;content.querySelector('.composer').before(runningLabel);
  $('autopilotBtn').insertAdjacentHTML('beforeend','<span>Autopilot</span>');
  const syncActivity=()=>{$('chatActivityCount').textContent=$('subagentsBadge').textContent||'';};
  new MutationObserver(syncActivity).observe($('subagentsBadge'),{childList:true,subtree:true,characterData:true});
  new MutationObserver(syncTheme).observe($('themeBtn'),{childList:true,subtree:true});syncTheme();

  function routeKey(s) {
    return [s.projectId, s.sessionId || '', s.model || ''].join('::');
  }
  function routeQuery(s) {
    return (
      'projectId=' +
      encodeURIComponent(s.projectId) +
      (s.sessionId ? '&sessionId=' + encodeURIComponent(s.sessionId) : '') +
      (s.model ? '&model=' + encodeURIComponent(s.model) : '')
    );
  }
  async function loadRoutePreview(s = engine.state(), force = false) {
    if (!s.projectId) return;
    const key = routeKey(s);
    if (routePending.has(key)) return routePending.get(key);
    if (!force && Date.now() - (routeFetched.get(key) || 0) < 5000) return routeCache.get(key);
    routeFetched.set(key, Date.now());
    const work = workspaceRequest('routing/preview?' + routeQuery(s))
      .then((data) => {
        routeCache.set(key, data);
        if (routeKey(engine.state()) === key) renderSendAccounts();
        return data;
      })
      .catch(() => undefined)
      .finally(() => routePending.delete(key));
    routePending.set(key, work);
    return work;
  }
  function routeAccount(name) {
    return accountName(engine.state().accounts.find((a) => a.name === name));
  }
  function routingCards(data) {
    return `<div class="route-decision"><small>Next turn · ${esc(data.strategy)}</small><strong>${data.selected ? esc(routeAccount(data.selected)) : 'Waiting for an eligible account'}</strong><p>${esc(data.reason)}. Selection is checked again when work starts.</p>${data.runningAccount ? `<p>Current turn: ${esc(routeAccount(data.runningAccount))}</p>` : ''}</div><div class="route-candidates">${data.candidates.map((c) => `<article><div><strong>${esc(routeAccount(c.name))}</strong><span class="route-badge ${c.eligible ? 'eligible' : ''}">${c.name === data.selected ? 'Selected' : c.eligible ? 'Fallback' : 'Excluded'}</span></div><p>${c.eligible ? 'Eligible for this turn' : esc(c.reasons.join(' · '))}</p><small>${c.load} active${c.maxConcurrent ? ' / ' + c.maxConcurrent + ' slots' : ''} · ${c.usedPercent === undefined ? 'Quota unknown' : Math.round(c.usedPercent) + '% used'}${c.reservePercent ? ' · ' + c.reservePercent + '% reserved' : ''}${c.quotaAt ? ' · Read ' + esc(new Date(c.quotaAt).toLocaleTimeString()) : ''}</small></article>`).join('')}</div>`;
  }
  async function showRouting(target = engine.state()) {
    const d = workspaceDialog(
      'Routing & accounts',
      `<nav class="route-tabs" aria-label="Routing views"><button class="active" data-tab="preview">Preview & controls</button><button data-tab="history">History</button></nav><div data-route-body>Loading…</div>`,
    );
    let tab = 'preview';
    async function render() {
      try {
        const el = d.querySelector('[data-route-body]');
        if (tab === 'history') {
          const data = await workspaceRequest('routing/history?' + routeQuery(target));
          if (!d.open || tab !== 'history') return;
          el.innerHTML = `${data.handoffs.map((h) => `<button class="cr-secondary route-link" data-handoff="${esc(h.sourceSessionId === target.sessionId ? h.targetSessionId : h.sourceSessionId)}">${h.sourceSessionId === target.sessionId ? 'Open continuation' : 'Open source conversation'} · ${providerName(h.targetProvider)}</button>`).join('')}<div class="route-history">${data.events.map((h) => `<article><time>${esc(new Date(h.at).toLocaleString())}</time><strong>${esc(h.kind.replaceAll('_', ' '))}</strong><p>${h.account ? esc(routeAccount(h.account)) + ' · ' : ''}${esc(h.model || h.provider || '')}</p>${h.kind === 'routing_preference' ? `<p>Next turn: ${h.detail.nextAccount ? esc(routeAccount(h.detail.nextAccount)) : 'Automatic'} · Lock: ${h.detail.lockedAccount ? esc(routeAccount(h.detail.lockedAccount)) : 'None'}${h.detail.useReserve ? ' · Priority work' : ''}</p>` : ''}${h.detail.reason ? `<small>${esc(h.detail.reason)}</small>` : ''}${h.detail.candidates ? `<details><summary>Decision details</summary>${routingCards(h.detail)}</details>` : ''}</article>`).join('') || '<p class="cr-empty">Routing history appears when a new turn starts.</p>'}</div>`;
          el.querySelectorAll('[data-handoff]').forEach(
            (b) =>
              (b.onclick = async () => {
                await engine.reloadProjects();
                await engine.select(target.projectId, b.dataset.handoff);
                d.close();
                open();
              }),
          );
          return;
        }
        const data = await workspaceRequest('routing/preview?' + routeQuery(target));
        if (!d.open || tab !== 'preview') return;
        routeCache.set(routeKey(target), data);
        const pool = engine.state().accounts.filter((a) => a.provider === data.provider),
          options = (selected) =>
            '<option value="">Automatic routing</option>' +
            pool
              .map(
                (a) =>
                  `<option value="${esc(a.name)}" ${a.name === selected ? 'selected' : ''}>${esc(accountName(a))}</option>`,
              )
              .join('');
        el.innerHTML = `${routingCards(data)}<form class="workspace-form route-controls"><label>Account for the next turn<select name="next">${options(data.preferences.nextAccount)}</select></label><label>Account lock<select name="lock">${options(data.preferences.lockedAccount)}</select></label><p class="cr-note">A lock stays with this conversation. Work waits if that account is unavailable. Changing a lock leaves the current attempt running.</p><label class="workspace-check"><input type="checkbox" name="reserve" ${data.preferences.useReserve ? 'checked' : ''}>Priority work: allow this conversation to use reserved quota</label><p class="cr-note">Provider limits and concurrent-task limits still apply.</p><p role="alert"></p><footer><button type="button" class="cr-secondary" data-switch ${!data.runningAccount ? 'disabled' : ''}>Switch now</button><button class="cr-primary">Save for next turn</button></footer><small>Switch now interrupts at a resumable boundary. Background work may stop when the account changes.</small></form>`;
        const f = el.querySelector('form');
        async function save(switchNow) {
          const buttons = f.querySelectorAll('button');
          buttons.forEach((b) => (b.disabled = true));
          try {
            const next = f.elements.next.value,
              lock = f.elements.lock.value;
            if (next && lock && next !== lock)
              throw new Error('Choose the locked account, or clear the lock.');
            if (switchNow && !next && !lock) throw new Error('Choose an account to switch to.');
            await workspaceRequest('routing/conversation', {
              projectId: target.projectId,
              sessionId: target.sessionId,
              nextAccount: next || null,
              lockedAccount: lock || null,
              useReserve: f.elements.reserve.checked,
            });
            if (switchNow)
              await workspaceRequest('switch', {
                projectId: target.projectId,
                sessionId: target.sessionId,
                account: next || lock,
              });
            routeCache.delete(routeKey(target));
            toast(switchNow ? 'Switch requested.' : 'Conversation routing saved.');
            await render();
            await loadRoutePreview(engine.state(), true);
          } catch (e) {
            f.querySelector('[role=alert]').textContent = e.message;
            buttons.forEach((b) => (b.disabled = false));
          }
        }
        f.onsubmit = (e) => {
          e.preventDefault();
          save(false);
        };
        f.querySelector('[data-switch]').onclick = () => save(true);
      } catch (e) {
        if (d.open) d.querySelector('[data-route-body]').textContent = e.message;
      }
    }
    d.querySelectorAll('[data-tab]').forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          d.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
          render();
        }),
    );
    render();
  }
  async function showHealth() {
    const d = workspaceDialog(
      'Account health & capacity',
      `<p class="cr-note">Checks local credentials, quota freshness, and cached model compatibility. No test prompt is sent.</p><div class="workspace-actions"><button class="cr-secondary" data-refresh>Refresh checks</button></div><div data-health>Loading…</div>`,
    );
    async function load() {
      try {
        const model = engine.state().model,
          rows = await workspaceRequest(
            'accounts/health' + (model ? '?model=' + encodeURIComponent(model) : ''),
          );
        if (!d.open) return;
        d.querySelector('[data-health]').innerHTML =
          `${model ? `<p class="cr-note">Requested model: ${esc(model)}</p>` : ''}<div class="health-grid">${rows.map((a) => `<form class="workspace-form health-card" data-account="${esc(a.name)}"><h3>${esc(a.displayName)}</h3><small>${providerName(a.provider)} · ${a.paused ? 'Paused' : a.load + ' active tasks'}</small><dl><dt>Authentication</dt><dd>${esc(a.credentials)}</dd><dt>Model</dt><dd>${esc(a.compatibility)}</dd><dt>Usage reading</dt><dd>${a.quotaAt ? esc(new Date(a.quotaAt).toLocaleString()) + (a.quotaStale ? ' · Stale' : ' · Recent') : 'Unavailable'}${a.quotaRetryAt ? '<br>Next retry ' + esc(new Date(a.quotaRetryAt).toLocaleTimeString()) : ''}</dd></dl><div class="capacity-fields"><label>Concurrent tasks<input name="capacity" type="number" min="0" max="100" step="1" value="${a.maxConcurrent}"><small>0 means unlimited</small></label><label>Reserve quota (%)<input name="reserve" type="number" min="0" max="95" value="${a.reservePercent}"><small>Held for priority work</small></label></div><p role="alert"></p><footer><button class="cr-secondary">Save limits</button></footer></form>`).join('')}</div><p class="cr-note">Reserves use the tightest applicable reported quota window. Unknown usage cannot enforce a reserve. Active and background tasks count toward capacity; new limits apply to future attempts.</p>`;
        d.querySelectorAll('form').forEach(
          (f) =>
            (f.onsubmit = async (e) => {
              e.preventDefault();
              const b = f.querySelector('button');
              b.disabled = true;
              try {
                await workspaceRequest('accounts/capacity', {
                  name: f.dataset.account,
                  maxConcurrent: Number(f.elements.capacity.value),
                  reservePercent: Number(f.elements.reserve.value),
                });
                f.querySelector('[role=alert]').classList.add('saved');
                f.querySelector('[role=alert]').textContent = 'Limits saved.';
                routeCache.clear();
                await engine.pollAccounts();
              } catch (e) {
                f.querySelector('[role=alert]').textContent = e.message;
              } finally {
                b.disabled = false;
              }
            }),
        );
      } catch (e) {
        d.querySelector('[data-health]').textContent = e.message;
      }
    }
    d.querySelector('[data-refresh]').onclick = load;
    load();
  }
  async function showHandoff(target = engine.state()) {
    const d = workspaceDialog(
      'Continue with another provider',
      `<div data-handoff-body>Preparing context…</div>`,
    );
    d.classList.add('handoff-dialog');
    try {
      const data = await workspaceRequest('routing/handoff?' + routeQuery(target));
      if (!d.open) return;
      d.querySelector('[data-handoff-body]').innerHTML =
        `<form class="workspace-form"><p class="cr-note">Start a linked conversation in the same project. Review the source excerpts below and add missing decisions or next steps.</p><fieldset class="route-provider"><legend>Continue with</legend>${data.providers.map((p, i) => `<label><input type="radio" name="provider" value="${p}" ${!i ? 'checked' : ''}>${providerName(p)}</label>`).join('') || '<p>Connect an account for another provider first.</p>'}</fieldset><label>Context to carry over<textarea name="context" rows="11" maxlength="50000" required>${esc(data.context)}</textarea></label><label>Next instruction<textarea name="instruction" rows="3" maxlength="10000" required placeholder="What should the next provider do?"></textarea></label><p class="cr-note">Finish or stop the source conversation, stop autopilot, and remove pending messages before starting.</p><p role="alert"></p><footer><button class="cr-primary" ${data.providers.length ? '' : 'disabled'}>Start continuation</button></footer></form>`;
      const f = d.querySelector('form'),
        storageKey = 'x056_handoff_' + target.projectId + '_' + target.sessionId;
      let ticket = null;
      try {
        ticket = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      } catch {}
      if (ticket) {
        f.elements.context.value = ticket.input.context;
        f.elements.instruction.value = ticket.input.instruction;
        f.elements.provider.value = ticket.input.provider;
        f.querySelectorAll('input,textarea').forEach((x) => (x.disabled = true));
        f.querySelector('button').textContent = 'Check continuation';
      }
      f.onsubmit = async (e) => {
        e.preventDefault();
        const b = f.querySelector('button');
        b.disabled = true;
        try {
          const input = {
            projectId: target.projectId,
            sessionId: target.sessionId,
            provider: f.elements.provider.value,
            context: f.elements.context.value,
            instruction: f.elements.instruction.value,
          };
          if (!ticket || JSON.stringify(ticket.input) !== JSON.stringify(input))
            ticket = { input, requestId: crypto.randomUUID() };
          sessionStorage.setItem(storageKey, JSON.stringify(ticket));
          f.querySelectorAll('input,textarea').forEach((x) => (x.disabled = true));
          const result = await workspaceRequest('routing/handoff', { ...input, requestId: ticket.requestId });
          if (result.status !== 'accepted' || !result.sessionId)
            throw new Error(
              'Delivery is uncertain. Keep this dialog open and retry to check the same request.',
            );
          sessionStorage.removeItem(storageKey);
          await engine.reloadProjects();
          await engine.select(target.projectId, result.sessionId);
          d.close();
          open();
        } catch (e) {
          f.querySelector('[role=alert]').textContent = e.message;
          b.disabled = false;
          b.textContent = 'Check continuation';
          try {
            const status = await workspaceRequest('messages/status?requestId=' + ticket.requestId);
            if (['failed', 'not_received'].includes(status.status)) {
              sessionStorage.removeItem(storageKey);
              ticket = null;
              f.querySelectorAll('input,textarea').forEach((x) => (x.disabled = false));
              b.textContent = 'Start continuation';
            }
          } catch {}
        }
      };
    } catch (e) {
      if (d.open) d.querySelector('[data-handoff-body]').textContent = e.message;
    }
  }

  // Review outputs and manage the workspace without adding permanent chat chrome.
  async function workspaceRequest(path,body){const r=await engine.api('/api/'+path,body===undefined?undefined:{method:'POST',body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.message||'Request failed');return j;}
  function workspaceDialog(title,body){const d=document.createElement('dialog');d.className='cr-dialog workspace-dialog';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="cr-icon" aria-label="Close">${ic('x')}</button></header>${body}`;if(d.querySelector('form')){d.classList.add('workspace-form-dialog');d.querySelectorAll('select[name=conversation],select[name=after]').forEach(select=>{if(select.disabled||select.options.length<13)return;const options=[...select.options].map(x=>({value:x.value,text:x.text})),search=document.createElement('input');search.type='search';search.placeholder='Find a project or conversation';search.setAttribute('aria-label','Filter '+(select.name==='after'?'dependency conversations':'conversations'));select.before(search);search.oninput=()=>{const value=select.value,query=search.value.toLowerCase();select.replaceChildren(...options.filter(x=>!x.value||x.value===value||x.text.toLowerCase().includes(query)).map(x=>new Option(x.text,x.value)));select.value=value;};});}document.body.append(d);d.querySelector('header button').onclick=()=>d.close();d.addEventListener('click',e=>{const r=d.getBoundingClientRect();if(e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))d.close();});d.addEventListener('close',()=>{d.querySelectorAll('img').forEach(img=>{if(img.src.startsWith('blob:'))URL.revokeObjectURL(img.src);});d.remove();});d.showModal();return d;}
  async function loadConversationMeta(){try{const data=await workspaceRequest('workspace/metadata');if(JSON.stringify(data)!==JSON.stringify(conversationMeta)){conversationMeta=data;boardSignature='';refresh();}}catch{}}
  function renderBulk(){const bar=$('crBulkBar');bar.hidden=!bulkMode;$('crSelectToggle').textContent=bulkMode?'Done selecting':'Select';bar.querySelector('strong').textContent=bulkSelection.size+' selected';$('crBulkAll').textContent=bulkCandidates.length>500?'Select first 500 matches':'Select all matches';bar.querySelectorAll('[data-bulk]').forEach(b=>b.disabled=!bulkSelection.size);}
  async function bulkAction(action){
    const selected=cards().filter(x=>bulkSelection.has(x.k));if(!selected.length)return;
    if(['read','unread','pin','unpin'].includes(action)){const before=selected.map(x=>({x,unread:x.unread,pinned:isStagePinned(x.p.id,x.c.sessionId)}));selected.forEach(x=>action==='read'||action==='unread'?engine.setConversationUnread(x.p.id,x.c.sessionId,action==='unread'):pinStage(x.p.id,x.c.sessionId,action==='pin'));toast('Updated '+selected.length+' conversations.',()=>{before.forEach(({x,unread,pinned})=>action==='read'||action==='unread'?engine.setConversationUnread(x.p.id,x.c.sessionId,unread):pinStage(x.p.id,x.c.sessionId,pinned));refresh();});refresh();return;}
    let tags;if(action==='tag'){const value=await engine.prompt({title:'Tag selected conversations',message:'Comma-separated tags. Leave blank to clear tags.',value:'',okText:'Apply'});if(value===null)return;tags=value.split(',').map(x=>x.trim()).filter(Boolean);}
    const previous=selected.map(x=>({projectId:x.p.id,sessionId:x.c.sessionId,archived:!!conversationMeta[x.k]?.archived,tags:conversationMeta[x.k]?.tags||[]}));
    try{conversationMeta=await workspaceRequest('workspace/metadata',{items:selected.map(x=>({projectId:x.p.id,sessionId:x.c.sessionId,...(tags?{tags}:{archived:action==='archive'})}))});bulkSelection.clear();boardSignature='';refresh();toast('Updated '+selected.length+' conversations.',async()=>{try{conversationMeta=await workspaceRequest('workspace/metadata',{items:previous});boardSignature='';refresh();}catch(e){toast(e.message);}});}catch(e){toast(e.message);}
  }
  $('crSelectToggle').onclick=()=>{bulkMode=!bulkMode;bulkSelection.clear();boardSignature='';renderBoard();};
  $('crBulkAll').onclick=()=>{bulkCandidates.slice(0,500).forEach(x=>bulkSelection.add(x.k));boardSignature='';renderBoard();};
  $('crBulkClear').onclick=()=>{bulkSelection.clear();boardSignature='';renderBoard();};
  $('crBulkBar').querySelectorAll('[data-bulk]').forEach(b=>b.onclick=()=>bulkAction(b.dataset.bulk));
  function conversationOptions(value=''){return cards().map(x=>`<option value="${esc(x.k)}" ${value===x.k?'selected':''}>${esc(x.p.name+' · '+(x.c.title||'Conversation'))}</option>`).join('');}
  const artifactKinds={image:'Screenshot',file:'File',preview:'Preview',test:'Test result'};
  async function artifactFile(item,download=false){const r=await engine.api('/api/workspace/artifact-file?id='+encodeURIComponent(item.id));if(!r.ok)throw new Error('File is unavailable');const blob=await r.blob(),url=URL.createObjectURL(blob);if(download){const a=document.createElement('a');a.href=url;a.download=item.original?.split('/').pop()||item.title;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);return;}return url;}
  function artifactCards(rows){return rows.map(x=>`<article class="artifact-card" data-artifact="${esc(x.id)}">${x.kind==='image'?`<button class="artifact-image" data-view="${esc(x.id)}" aria-label="View ${esc(x.title)}"><img alt="${esc(x.title)}" loading="lazy"></button>`:''}<div class="artifact-copy"><small>${artifactKinds[x.kind]} · ${esc(relativeDate(x.at))}</small><strong>${esc(x.title)}</strong>${x.kind==='test'?`<p class="test-result ${esc(x.status)}">${esc(x.summary)}</p><small>${x.source==='response'?'Reported by assistant':'Added manually'}</small>`:''}<small>${esc(engine.state().projects.find(p=>p.id===x.projectId)?.name||'Project')} · ${esc(cards().find(c=>c.k===x.projectId+'::'+x.sessionId)?.c.title||'Conversation')}</small><div class="artifact-actions">${x.url?`<a class="cr-secondary" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Open preview ${ic('up')}</a>`:x.file?`<button class="cr-secondary" data-download="${esc(x.id)}">Download</button>`:''}<button class="cr-text-button" data-source="${esc(x.id)}">Conversation</button><button class="cr-icon" data-remove-artifact="${esc(x.id)}" aria-label="Remove from library">${ic('x')}</button></div></div></article>`).join('')||'<div class="cr-empty">No saved outputs in this view.</div>';}
  function bindArtifacts(container,rows,reload){const byId=new Map(rows.map(x=>[x.id,x]));container.querySelectorAll('.artifact-image img').forEach(async img=>{try{const url=await artifactFile(byId.get(img.closest('[data-artifact]').dataset.artifact));if(img.isConnected)img.src=url;else URL.revokeObjectURL(url);}catch{img.alt='Image unavailable';}});container.querySelectorAll('[data-view]').forEach(b=>b.onclick=async()=>{const x=byId.get(b.dataset.view);try{const url=await artifactFile(x),d=workspaceDialog(x.title,'<img class="artifact-large" alt="">');d.querySelector('img').src=url;d.querySelector('img').alt=x.title;}catch(e){toast(e.message);}});container.querySelectorAll('[data-download]').forEach(b=>b.onclick=()=>artifactFile(byId.get(b.dataset.download),true).catch(e=>toast(e.message)));container.querySelectorAll('[data-source]').forEach(b=>b.onclick=async()=>{const x=byId.get(b.dataset.source);b.closest('dialog')?.close();await engine.select(x.projectId,x.sessionId);open();});container.querySelectorAll('[data-remove-artifact]').forEach(b=>b.onclick=async()=>{try{await workspaceRequest('workspace/artifacts/remove',{id:b.dataset.removeArtifact});reload();}catch(e){toast(e.message);}});}
  async function addArtifact(pid,sid,reload){const current=pid&&sid?pid+'::'+sid:key(),d=workspaceDialog('Add to artifact library',`<form class="workspace-form"><label>Conversation<select name="conversation">${conversationOptions(current)}</select></label><label>Type<select name="kind"><option value="file">Screenshot or file</option><option value="preview">Preview link</option><option value="test">Test result</option></select></label><label>Title<input name="title" placeholder="Optional title"></label><label id="artifactValueLabel">File path<input name="value" required placeholder="/tmp/screenshot.png"></label><label class="test-status-field" hidden>Result<select name="status"><option value="passed">Passed</option><option value="failed">Failed</option><option value="reported">Reported</option></select></label><p role="alert"></p><footer><button class="cr-primary">Save</button></footer></form>`);const f=d.querySelector('form');f.elements.kind.onchange=()=>{const kind=f.elements.kind.value;d.querySelector('#artifactValueLabel').firstChild.textContent=kind==='file'?'File path':kind==='preview'?'Preview URL':'Test summary';f.elements.value.placeholder=kind==='file'?'/tmp/screenshot.png':kind==='preview'?'https://…':'Tests: 24 passed';d.querySelector('.test-status-field').hidden=kind!=='test';};f.onsubmit=async e=>{e.preventDefault();const [projectId,sessionId]=f.elements.conversation.value.split('::'),kind=f.elements.kind.value;f.querySelector('button').disabled=true;try{await workspaceRequest('workspace/artifacts',{projectId,sessionId,title:f.elements.title.value,...(kind==='file'?{path:f.elements.value.value}:kind==='preview'?{url:f.elements.value.value}:{summary:f.elements.value.value,status:f.elements.status.value})});d.close();reload();}catch(err){f.querySelector('[role=alert]').textContent=err.message;f.querySelector('button').disabled=false;}};}
  async function loadArtifacts(){const el=$('artifactItems');try{artifactRows=await workspaceRequest('workspace/artifacts');renderArtifacts();}catch(e){el.textContent=e.message;}}
  function renderArtifacts(){const query=$('artifactSearch').value.toLowerCase(),pid=$('artifactProject').value,kind=$('artifactKinds').querySelector('.selected')?.dataset.kind||'';const rows=artifactRows.filter(x=>(!pid||x.projectId===pid)&&(!kind||x.kind===kind)&&(!query||(x.title+' '+(x.summary||'')).toLowerCase().includes(query)));$('artifactItems').querySelectorAll('img').forEach(img=>{if(img.src.startsWith('blob:'))URL.revokeObjectURL(img.src);});$('artifactItems').innerHTML=artifactCards(rows);bindArtifacts($('artifactItems'),rows,loadArtifacts);}
  async function showResults(target=engine.state()){const {projectId,sessionId}=target;if(!sessionId){toast('Open a conversation first.');return;}const d=workspaceDialog('Conversation results',`<p class="cr-note">Screenshots, previews, and reported test results.</p><div class="workspace-actions"><button class="cr-secondary" data-add>Add output</button><button class="cr-secondary" data-scan>Find outputs in recent replies</button></div><div class="artifact-grid" data-results>Loading…</div>`);async function load(scan=false){try{const rows=scan?await workspaceRequest('workspace/artifacts/scan',{projectId,sessionId}):await workspaceRequest('workspace/artifacts?projectId='+encodeURIComponent(projectId)+'&sessionId='+encodeURIComponent(sessionId));if(!d.open)return;d.querySelector('[data-results]').innerHTML=artifactCards(rows.filter(x=>x.kind!=='file'));bindArtifacts(d.querySelector('[data-results]'),rows,()=>load());}catch(e){d.querySelector('[data-results]').textContent=e.message;}}d.querySelector('[data-add]').onclick=()=>addArtifact(projectId,sessionId,()=>load());d.querySelector('[data-scan]').onclick=()=>load(true);load(true);}
  async function loadPlanner(){try{plannerRows=await workspaceRequest('queue');renderPlanner();}catch(e){$('plannerItems').textContent=e.message;}}
  function queueReason(item){
    if(item.dispatching)return 'Interrupted delivery · review conversation before resuming';
    const reasons=[];
    if(item.paused)reasons.push(item.error?'Paused: '+item.error:'Paused');
    if(item.notBefore>Date.now())reasons.push('Scheduled '+new Date(item.notBefore).toLocaleString());
    const dep=cards().find(x=>x.c.sessionId===item.afterSessionId);
    if(dep&&['running','background'].includes(dep.status))reasons.push('Waiting for '+dep.c.title);
    if(!reasons.length){const target=cards().find(x=>x.c.sessionId===item.sessionId),queue=Object.values(plannerRows).find(rows=>rows.some(x=>x.id===item.id))||[],head=queue.find(x=>x.sessionId===item.sessionId);reasons.push(head&&head.id!==item.id?'Waiting for earlier message':target&&['running','background'].includes(target.status)?'Waiting for current turn':'Ready to send');}
    return reasons.join(' · ');
  }
  function renderPlanner(){const pid=$('plannerProject').value;const rows=Object.entries(plannerRows).filter(([p])=>!pid||pid===p).flatMap(([projectId,items])=>items.map((item,index)=>({projectId,item,index})));$('plannerItems').innerHTML=rows.map(({projectId,item,index})=>`<article class="planner-item" draggable="true" data-queue="${esc(item.id)}" data-project="${esc(projectId)}"><span class="planner-order" title="Drag to reorder">${index+1}</span><div class="planner-copy"><strong>${esc(cards().find(x=>x.c.sessionId===item.sessionId)?.c.title||'Conversation')}</strong><p>${esc(item.text)}</p><small>${esc(engine.state().projects.find(p=>p.id===projectId)?.name)} · ${esc(queueReason(item))}</small></div><div class="planner-actions"><button class="cr-icon" data-move="-1" aria-label="Move up">${ic('up')}</button><button class="cr-icon" data-move="1" aria-label="Move down">${ic('down')}</button><button class="cr-secondary" data-edit>Edit</button><button class="cr-secondary" data-pause>${item.paused||item.dispatching?'Resume':'Pause'}</button><button class="cr-icon" data-remove aria-label="Remove queued message">${ic('x')}</button></div></article>`).join('')||'<div class="cr-empty">No messages waiting. Plan a message to get started.</div>';
    $('plannerItems').querySelectorAll('[data-queue]').forEach(el=>{const p=el.dataset.project,id=el.dataset.queue,item=plannerRows[p].find(x=>x.id===id);el.querySelector('[data-edit]').onclick=()=>editPlannedMessage(p,item);el.querySelector('[data-pause]').onclick=()=>workspaceRequest('queue/edit',{projectId:p,id,paused:item.dispatching?false:!item.paused}).then(loadPlanner).catch(e=>toast(e.message));el.querySelector('[data-remove]').onclick=()=>workspaceRequest('queue/remove',{projectId:p,id}).then(loadPlanner).catch(e=>toast(e.message));el.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>movePlanned(p,id,Number(b.dataset.move)));el.ondragstart=e=>e.dataTransfer.setData('text/plain',JSON.stringify({projectId:p,id}));el.ondragover=e=>e.preventDefault();el.ondrop=e=>{e.preventDefault();try{const moved=JSON.parse(e.dataTransfer.getData('text/plain'));if(moved.projectId!==p)return;const items=plannerRows[p],from=items.findIndex(x=>x.id===moved.id),to=items.findIndex(x=>x.id===id);movePlanned(p,moved.id,to-from);}catch{}};});}
  async function movePlanned(pid,id,delta){const ids=plannerRows[pid].map(x=>x.id),from=ids.indexOf(id),to=Math.max(0,Math.min(ids.length-1,from+delta));ids.splice(from,1);ids.splice(to,0,id);try{await workspaceRequest('queue/reorder',{projectId:pid,ids});await loadPlanner();}catch(e){toast(e.message);loadPlanner();}}
  function editPlannedMessage(pid,item){const current=item?pid+'::'+item.sessionId:key(),d=workspaceDialog(item?'Edit planned message':'Plan a message',`<form class="workspace-form"><label>Conversation<select name="conversation" ${item?'disabled':''}>${conversationOptions(current)}</select></label><label>Message<textarea name="prompt" rows="5" required>${esc(item?.text||'')}</textarea></label><label>Start no earlier than<input name="time" type="datetime-local"></label><label>Wait until this conversation is idle<select name="after"><option value="">No dependency</option>${conversationOptions()}</select></label><label class="workspace-check"><input type="checkbox" name="paused" ${item?.paused?'checked':''}>Keep paused until I resume it</label><p role="alert"></p><footer><button class="cr-primary">${item?'Save changes':'Add to queue'}</button></footer></form>`);const f=d.querySelector('form');if(item?.notBefore){const date=new Date(item.notBefore);f.elements.time.value=new Date(date-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}if(item?.afterSessionId){const dep=cards().find(x=>x.c.sessionId===item.afterSessionId);f.elements.after.value=dep?.k||'';}f.onsubmit=async e=>{e.preventDefault();const [projectId,sessionId]=f.elements.conversation.value.split('::'),afterSessionId=f.elements.after.value.split('::')[1]||'';f.querySelector('button').disabled=true;try{await workspaceRequest(item?'queue/edit':'queue',{projectId,sessionId,id:item?.id,prompt:f.elements.prompt.value,notBefore:f.elements.time.value?new Date(f.elements.time.value).getTime():0,afterSessionId,paused:f.elements.paused.checked,...(!item?{requestId:crypto.randomUUID()}:{})});d.close();loadPlanner();}catch(err){f.querySelector('[role=alert]').textContent=err.message;f.querySelector('button').disabled=false;}};}
  function workspaceProjectOptions(){return '<option value="">All projects</option>'+engine.state().projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');}
  on('chatResults',()=>showResults());on('crArtifactsTab',()=>showSection('artifacts'));on('crPlannerTab',()=>showSection('planner'));
  on('artifactAdd',()=>addArtifact(null,null,loadArtifacts));on('artifactRefresh',loadArtifacts);on('plannerAdd',()=>editPlannedMessage());on('plannerRefresh',loadPlanner);
  $('artifactSearch').oninput=renderArtifacts;$('artifactProject').onchange=renderArtifacts;$('plannerProject').onchange=renderPlanner;
  $('artifactKinds').querySelectorAll('button').forEach(b=>b.onclick=()=>{$('artifactKinds').querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===b));renderArtifacts();});
  setInterval(()=>{if(document.hidden)return;loadConversationMeta();if(section==='planner')loadPlanner();},5000);setTimeout(loadConversationMeta,1000);

  setMode('closed'); projectNav(false); refresh();
  return { notify:toast, renderRuns, showCosts:()=>{renderCostDetails();costDialog.showModal();loadProjectCosts(true);}, showSettings:settings, conversationMenu, openUtility, closeUtility, error:message=>{ $('crBoardError').textContent=message; }, open, refresh, event, rememberPosition, restorePosition, isOpen:()=>mode!=='closed', beforeSwitch:rememberPosition, afterHistory:restorePosition, showAccounts:()=>showSection('accounts') };
};
