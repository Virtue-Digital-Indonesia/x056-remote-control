/* Project navigation around the existing authenticated conversation surfaces. */
window.createProjectWorkspace = function(engine, room, chat, spaces) {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=n=>`<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const settingsSections=[['/settings','General','general'],['/settings/notifications','Notifications','notifications'],['/settings/models','Models','models'],['/settings/routing','Routing','routing'],['/settings/memory','Memory','memory'],['/settings/connections','Connections','connections'],['/settings/security','Security','security']];
  const globals={'/':'board','/home':'board','/activity':'board','/activity/queue':'planner','/activity/automations':'automations','/activity/outputs':'artifacts','/accounts':'accounts','/accounts/tools':'connections','/memory':'memory','/settings':'preferences','/work/unassigned':'board'};
  for(const [url] of settingsSections)globals[url]='preferences';
  const aliases={'/dashboard':'/accounts','/queue':'/activity/queue','/automations':'/activity/automations','/artifacts':'/activity/outputs'};
  const canonical=p=>aliases[p]||(/^\/settings\//.test(p)&&!settingsRoute(p)?'/settings':p);
  const labels={'/':'Home','/home':'Home','/activity':'Activity','/activity/queue':'Activity / Queued messages','/activity/automations':'Activity / Automations','/activity/outputs':'Activity / Outputs','/accounts':'Accounts & tools','/accounts/tools':'Accounts & tools / Tools','/memory':'Workspace memory','/settings':'Settings','/work/unassigned':'Unassigned Work'};
  for(const [url,name] of settingsSections)if(url!=='/settings')labels[url]='Settings / '+name;
  const settingsRoute=p=>settingsSections.some(([url])=>url===p);
  const sectionOf=p=>(settingsSections.find(([url])=>url===p)||settingsSections[0])[2];
  const SEP='<span class="crumb-sep">/</span>';
  const link=(url,text,cls='')=>`<a href="${esc(url)}" data-workspace-link class="${cls}">${text}</a>`;
  let mounted=false,navSignature='',navContext='',renderTimer,routeSerial=0,activeRoute='',returnPath='/home',enteredPage=null;
  const expandedProjects=new Set();
  let sidebar;
  const projectTabs=[['overview','Overview','layout'],['chat','Chat','chat'],['work','Work','terminal'],['files','Files','file'],['memory','Memory','snippet']];
  const handles=p=>Object.hasOwn(globals,canonical(p));
  function viewNav(host,items,label){
    if(!host)return;let nav=host.querySelector('.workspace-view-nav');
    if(!nav){nav=document.createElement('nav');nav.className='workspace-view-nav workspace-activity-links';nav.setAttribute('aria-label',label);host.querySelector('.cr-heading').after(nav);}
    const markup=items.map(([url,name])=>link(url,name)).join('');if(nav.dataset.links!==markup){nav.innerHTML=markup;nav.dataset.links=markup;}
    nav.querySelectorAll('a').forEach(a=>{if(a.getAttribute('href')===location.pathname)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  }
  function context() {
    const pathname=location.pathname,parts=pathname.split('/').filter(Boolean).map(p=>{try{return decodeURIComponent(p);}catch{return '';}});
    if(parts[0]==='projects')return {id:parts[1],tab:parts[2]||'overview'};
    if(parts[0]==='chat'&&parts[1]){const p=engine.state().projects.find(p=>p.id===parts[1]);return {id:p&&(spaces.scopeOf(p,p.lastSessionId)||p.spaceId),tab:'chat'};}
    if(parts[0]==='work'&&parts[1]&&parts[1]!=='unassigned'){const p=engine.state().projects.find(p=>p.id===parts[1]);return {id:parts[2]?spaces.scopeOf(p,parts[2]):p?.workSpaceId,tab:'work'};}
    return {};
  }
  function sidebarItem(url,label,ic,current=false,extra='') {return `<a href="${esc(url)}" data-workspace-link class="cr-project-link${current?' selected':''}"${current?' aria-current="page"':''}>${icon(ic)}<span>${esc(label)}</span>${extra}</a>`;}
  function renderNav() {
    if(!mounted)return;
    const current=context(),query=$('crProjectSearch').value.trim().toLowerCase(),projects=spaces.list().filter(p=>!p.archivedAt);
    const nextContext=(current.id||'')+'/'+(current.tab||'');
    const contextChanged=navContext!==nextContext;if(contextChanged&&current.id)expandedProjects.add(current.id);navContext=nextContext;
    const markup=projects.filter(p=>p.name.toLowerCase().includes(query)).map(p=>{const expanded=expandedProjects.has(p.id),children=expanded?`<div class="workspace-project-children">${projectTabs.map(([tab,name,ic])=>sidebarItem('/projects/'+encodeURIComponent(p.id)+'/'+tab,name,ic,current.id===p.id&&tab===current.tab,['chat','work'].includes(tab)?`<small>${(p.members||[]).filter(m=>m.mode===tab).length}</small>`:'')).join('')}</div>`:'';return `<div data-sidebar-project="${esc(p.id)}" class="workspace-project-node${current.id===p.id?' active':''}"><div class="workspace-project-heading">${sidebarItem('/projects/'+encodeURIComponent(p.id)+'/overview',p.name,'folder',false,p.activity?.needsInput?`<small class="attention">${p.activity.needsInput}</small>`:'')}<button class="cr-icon" data-project-toggle="${esc(p.id)}" aria-expanded="${expanded}" aria-label="${expanded?'Collapse':'Expand'} ${esc(p.name)}">${icon('chevron')}</button></div>${children}</div>`;}).join('')||`<p class="workspace-nav-empty">${query?'No matching projects':'No projects yet'}</p>`;
    if(navSignature!==markup){navSignature=markup;const focused=document.activeElement?.closest('#crProjectLinks a')?.getAttribute('href'),toggle=document.activeElement?.closest('[data-project-toggle]')?.dataset.projectToggle;$('crProjectLinks').innerHTML=markup;$('crProjectLinks').querySelectorAll('[data-project-toggle]').forEach(button=>button.onclick=()=>{expandedProjects.has(button.dataset.projectToggle)?expandedProjects.delete(button.dataset.projectToggle):expandedProjects.add(button.dataset.projectToggle);navSignature='';renderNav();requestAnimationFrame(()=>document.querySelector('[data-project-toggle="'+CSS.escape(button.dataset.projectToggle)+'"]')?.focus());});if(focused)[...$('crProjectLinks').querySelectorAll('a')].find(a=>a.getAttribute('href')===focused)?.focus({preventScroll:true});else if(toggle)$('crProjectLinks').querySelector('[data-project-toggle="'+CSS.escape(toggle)+'"]')?.focus({preventScroll:true});}
    if(contextChanged){const selected=$('crProjectLinks').querySelector('[aria-current=page]');if(selected){const container=$('crProjectLinks'),a=selected.getBoundingClientRect(),b=container.getBoundingClientRect();if(a.bottom>b.bottom)container.scrollTop+=a.bottom-b.bottom+8;else if(a.top<b.top)container.scrollTop-=b.top-a.top+8;}}
    const pathname=location.pathname;
    document.querySelectorAll('[data-global-destination]').forEach(a=>{const href=a.getAttribute('href'),selected=href===pathname||(pathname==='/'&&href==='/home')||(['/activity','/accounts'].includes(href)&&pathname.startsWith(href+'/'));if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const p=projects.find(p=>p.id===current.id);
    const name=p?.name||labels[pathname]||(pathname==='/projects'?'All Projects':pathname.startsWith('/chat')?'Chat':pathname.startsWith('/work')?'Work':'Workspace');
    const crumbs=link('/home','Workspace')+SEP+(p?link('/projects/'+encodeURIComponent(p.id)+'/overview',esc(name))+SEP+`<span>${esc(current.tab[0].toUpperCase()+current.tab.slice(1))}</span>`:`<span>${esc(name)}</span>`);
    if($('crBreadcrumb').dataset.crumbs!==crumbs){$('crBreadcrumb').innerHTML=crumbs;$('crBreadcrumb').dataset.crumbs=crumbs;window.rcMotion?.crumbs($('crBreadcrumb'));}
    $('controlRoom').inert=false;
    const drawerOpen=innerWidth<=850&&$('controlRoom').classList.contains('projects-open');
    document.querySelectorAll('#crWorkspace>.cr-page').forEach(n=>n.inert=document.body.dataset.chatMode==='page'||drawerOpen);
    $('conversationSurface').inert=drawerOpen;
    $('crProjectNav').inert=innerWidth<=850&&!drawerOpen;
    $('menuBtn').setAttribute('aria-expanded',String(drawerOpen));
    $('menuBtn').setAttribute('aria-controls','crProjectNav');
    $('menuBtn').setAttribute('aria-label','Open workspace navigation');
    const isGlobal=handles(pathname),home=['/','/home'].includes(pathname),activity=pathname==='/activity'||pathname.startsWith('/activity/');
    const activityViews=[['/activity','Conversations'],['/activity/queue','Queued messages'],['/activity/automations','Automations'],['/activity/outputs','Outputs']];
    viewNav($('crBoard'),activity?activityViews:[['/home','Recent'],['/chat','All Chats'],['/work/unassigned','Unassigned Work'],['/work','Work repositories']],'Conversation views');
    $('crBoard').querySelector('.workspace-view-nav').hidden=!home&&!activity&&pathname!=='/work/unassigned';
    $('crStats').hidden=home;
    $('crBoard').querySelector('.cr-tabs').hidden=home;
    $('crSelectToggle').hidden=home;
    for(const id of ['crPlanner','crAutomations','crArtifacts']){viewNav($(id),activityViews,'Activity views');$(id).querySelector('.cr-heading h1').textContent='Activity';}
    const accountViews=[['/accounts','Accounts & usage'],['/accounts/tools','Tools']];
    if($('accountProvider')){viewNav($('crAccounts'),accountViews,'Account views');$('crAccounts').querySelector('.cr-heading h1').textContent='Accounts & tools';$('crAccounts').querySelector('.cr-heading p').textContent='Provider accounts, usage charts, and estimated spend.';}
    if($('workspaceConnections').querySelector('.cr-heading'))viewNav($('workspaceConnections'),accountViews,'Account views');
    $('crNew').hidden=activity;
    const newLabel=icon('plus')+(home?' New Chat':' New conversation');if($('crNew').dataset.label!==newLabel){$('crNew').innerHTML=newLabel;$('crNew').dataset.label=newLabel;}
    if($('workspaceSettingsBody'))viewNav($('workspacePreferences'),settingsSections.map(([url,name])=>[url,name]),'Settings sections');
    $('workspaceConnections').hidden=pathname!=='/accounts/tools';$('workspacePreferences').hidden=!settingsRoute(pathname);
    if(!isGlobal){$('workspaceConnections').hidden=true;$('workspacePreferences').hidden=true;}
    // The old list remains the /chat library. Conversation pages use the same
    // parent navigation as Work and retain their transcript/composer nodes.
    if($('rcChatHome')){$('rcChatHome').innerHTML='<h1>Chat</h1>';}
    if($('rcChatControl'))$('rcChatControl').textContent='Home';
    sidebar?.sync();
    window.rcMotion?.marker();
  }
  function focusNavigation(){(document.body.dataset.chatMode==='page'&&innerWidth<=850?$('menuBtn'):$('crProjects')).focus();}
  function closeDrawer(){
    $('controlRoom').classList.remove('projects-open');$('crProjectVeil').hidden=true;$('crProjects').setAttribute('aria-expanded','false');
    $('crProjectNav').inert=innerWidth<=850;
    document.querySelectorAll('#crWorkspace>.cr-page').forEach(n=>n.inert=false);
    $('conversationSurface').inert=false;
    $('menuBtn').setAttribute('aria-expanded','false');
  }
  function mount() {
    if(mounted)return;mounted=true;document.body.classList.add('rc-workspace-ready');
    const nav=$('crProjectNav'),primary=nav.querySelector('.cr-primary-nav');
    nav.insertAdjacentHTML('afterbegin',link('/home','<svg class="workspace-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor"/><path d="m9 10 6 6-6 6m9 0h6" fill="none" stroke="var(--bg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Remote Control</span>','workspace-brand')+'<button id="workspaceSearch" class="workspace-search">'+icon('search')+' Search anything <kbd>⌘ K</kbd></button>');
    nav.insertAdjacentHTML('afterbegin','<button id="workspaceNavClose" class="cr-icon" aria-label="Close workspace navigation">'+icon('x')+'</button>');
    $('workspaceNavClose').onclick=()=>{closeDrawer();focusNavigation();};
    $('workspaceSearch').onclick=()=>$('searchChatsBtn').click();
    const destinations=[['crHomeTab','/home','Home','home'],['crSpacesTab','/projects','All Projects','folder'],['workspaceActivity','/activity','Activity','activity'],['crAccountsTab','/accounts','Accounts & tools','user'],['crMemoryTab','/memory','Workspace memory','snippet'],['sidebarSettings','/settings','Settings','gear']];
    const bottom=document.createElement('nav');bottom.className='cr-primary-nav workspace-global-nav';bottom.setAttribute('aria-label','Workspace tools');nav.append(bottom);
    for(const [id,url,label,ic] of destinations){let a=document.createElement('a');a.id=id;a.href=url;a.dataset.workspaceLink='';a.dataset.globalDestination='';a.innerHTML=icon(ic)+'<span>'+label+'</span>';const old=$(id);if(old)old.replaceWith(a);(url==='/home'||url==='/projects'?primary:bottom).append(a);}
    // Preserve the all-Work route and repository management without listing every
    // repository a second time in the Project sidebar.
    for(const id of ['crBoardTab','crChatTab','crManageProjects','crAutomationsTab','crArtifactsTab','crPlannerTab','crSettings'])$(id).hidden=true;
    nav.querySelector('header span').textContent='PROJECTS';
    $('crProjects').innerHTML=icon('folder')+'<span>Projects</span>';$('crProjects').setAttribute('aria-label','Choose Project');$('crProjects').setAttribute('aria-controls','crProjectNav');
    $('crProjects').addEventListener('click',renderNav);$('crProjectVeil').addEventListener('click',renderNav);
    $('crHome').hidden=true;
    $('crWorkspace').insertAdjacentHTML('beforeend','<section id="workspaceConnections" class="cr-page" hidden></section><section id="workspacePreferences" class="cr-page" hidden></section>');
    $('workspacePreferences').innerHTML='<div class="cr-heading"><div><h1>Settings</h1><p>Workspace preferences, routing, connections, and security.</p></div></div><div id="workspaceSettingsBody" class="workspace-settings-body"></div>';
    $('crNew').addEventListener('click',event=>{if(['/','/home'].includes(location.pathname)){event.preventDefault();event.stopImmediatePropagation();chat.newChat();}},true);
    sidebar=createSidebar();
    // These controls have older listeners; capture ensures one route transition.
    document.addEventListener('click',event=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const a=event.target.closest('a[data-workspace-link]');
      const home=event.target.closest('#focusHome,#focusBack,#crHome,#chatClose');
      if(a){event.preventDefault();event.stopImmediatePropagation();a.closest('dialog')?.close();navigate(new URL(a.href).pathname).catch(e=>room.notify(e.message));}
      else if(home){event.preventDefault();event.stopImmediatePropagation();(home.id==='chatClose'?closeConversation():navigate('/home')).catch(e=>room.notify(e.message));}
    },true);
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog[open],:popover-open')&&$('controlRoom').classList.contains('projects-open')){event.preventDefault();event.stopImmediatePropagation();closeDrawer();focusNavigation();}
      if(event.key==='Tab'&&innerWidth<=850&&$('controlRoom').classList.contains('projects-open')){const nodes=[...nav.querySelectorAll('a,button,input')].filter(n=>n.getClientRects().length),first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    },true);
  }
  function createSidebar() {
    const nav=$('crProjectNav'),desktop=matchMedia('(min-width:851px)');
    let width=236,collapsed=false,trigger=null,projectId='',closeTimer,drag=null,suppressFocus=false;
    try{const saved=JSON.parse(localStorage.getItem('x056_workspace_sidebar')||'{}');if(Number.isFinite(saved.width))width=saved.width;collapsed=saved.collapsed===true;}catch{}
    const maximum=()=>Math.min(420,Math.max(200,innerWidth-560));
    const bounded=value=>Math.round(Math.max(200,Math.min(maximum(),value)));
    const isRail=()=>desktop.matches&&collapsed;
    const save=()=>{try{localStorage.setItem('x056_workspace_sidebar',JSON.stringify({width,collapsed}));}catch{}};
    nav.insertAdjacentHTML('afterbegin','<button id="workspaceSidebarToggle" class="cr-icon" aria-controls="crProjectNav"></button>');
    const toggle=$('workspaceSidebarToggle');
    const splitter=document.createElement('div');splitter.id='workspaceSidebarResize';splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-orientation','vertical');splitter.setAttribute('aria-label','Sidebar width');splitter.setAttribute('aria-controls','crProjectNav');
    const flyout=document.createElement('nav');flyout.id='workspaceProjectFlyout';flyout.hidden=true;flyout.setAttribute('aria-label','Project navigation');
    document.body.append(splitter,flyout);
    function close(restore=false){clearTimeout(closeTimer);const previous=trigger;flyout.hidden=true;trigger=null;projectId='';previous?.setAttribute('aria-expanded','false');if(restore&&previous?.isConnected){suppressFocus=true;previous.focus({preventScroll:true});suppressFocus=false;}}
    function scheduleClose(){clearTimeout(closeTimer);closeTimer=setTimeout(()=>{if(!flyout.matches(':hover')&&!flyout.contains(document.activeElement)&&!trigger?.matches(':hover')&&document.activeElement!==trigger)close();},220);}
    function position(){if(!trigger)return;const rect=trigger.getBoundingClientRect();flyout.style.left=(nav.getBoundingClientRect().right-1)+'px';flyout.style.top=Math.max(8,Math.min(rect.top,innerHeight-flyout.offsetHeight-8))+'px';}
    function reveal(){clearTimeout(closeTimer);const links=flyout.querySelector('.workspace-flyout-links');if(links){links.hidden=false;flyout.querySelector('button')?.setAttribute('aria-expanded','true');position();}}
    function show(anchor,full=false){
      clearTimeout(closeTimer);const id=anchor.closest('[data-sidebar-project]')?.dataset.sidebarProject,p=spaces.list().find(p=>p.id===id);if(!p)return;
      if(projectId!==id||flyout.hidden){close();trigger=anchor;projectId=id;flyout.innerHTML='<button class="workspace-flyout-name" aria-expanded="false">'+icon('folder')+'<span>'+esc(p.name)+'</span></button><div class="workspace-flyout-links" hidden>'+projectTabs.map(([tab,name,ic])=>sidebarItem('/projects/'+encodeURIComponent(id)+'/'+tab,name,ic,context().id===id&&context().tab===tab,['chat','work'].includes(tab)?'<small>'+(p.members||[]).filter(m=>m.mode===tab).length+'</small>':'')).join('')+'</div>';flyout.querySelector('button').onclick=()=>{reveal();flyout.querySelector('a').focus();};flyout.hidden=false;}
      trigger.setAttribute('aria-expanded','true');position();if(full)reveal();
    }
    function sync(){
      document.body.classList.toggle('workspace-sidebar-collapsed',isRail());document.body.style.setProperty('--workspace-sidebar-width',bounded(width)+'px');
      toggle.innerHTML=icon('chevron');toggle.setAttribute('aria-label',collapsed?'Expand sidebar':'Collapse sidebar');toggle.title=collapsed?'Expand sidebar':'Collapse sidebar';toggle.setAttribute('aria-expanded',String(!collapsed));
      splitter.setAttribute('aria-valuemin',String(collapsed?64:200));splitter.setAttribute('aria-valuemax',String(maximum()));splitter.setAttribute('aria-valuenow',String(collapsed?64:bounded(width)));splitter.setAttribute('aria-valuetext',collapsed?'Collapsed':bounded(width)+' pixels');
      nav.querySelectorAll('a,button').forEach(a=>{if(!a.title)a.title=a.textContent.trim()||a.getAttribute('aria-label')||'';if(!a.hasAttribute('aria-label')&&a.title)a.setAttribute('aria-label',a.title);});
      nav.querySelectorAll('.workspace-project-heading>a').forEach(a=>{a.setAttribute('aria-label',a.textContent.trim());if(isRail()){a.removeAttribute('title');a.setAttribute('role','button');a.setAttribute('aria-controls',flyout.id);a.setAttribute('aria-expanded',String(!flyout.hidden&&a.closest('[data-sidebar-project]').dataset.sidebarProject===projectId));}else{a.removeAttribute('role');a.removeAttribute('aria-controls');a.removeAttribute('aria-expanded');}});
      if(!isRail())close();else if(projectId){trigger=nav.querySelector('[data-sidebar-project="'+CSS.escape(projectId)+'"] .workspace-project-heading>a');if(!trigger)close();else position();}
    }
    function setCollapsed(value){close();collapsed=value;save();sync();window.dispatchEvent(new Event('resize'));}
    toggle.onclick=()=>setCollapsed(!collapsed);
    splitter.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();setCollapsed(!collapsed);return;}if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();collapsed=false;width=bounded(event.key==='Home'?200:event.key==='End'?maximum():bounded(width)+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?40:10));save();sync();};
    splitter.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();close();drag={id:event.pointerId,width,collapsed};splitter.setPointerCapture(event.pointerId);document.body.classList.add('workspace-sidebar-resizing');};
    splitter.onpointermove=event=>{if(!drag)return;collapsed=false;width=bounded(event.clientX);sync();};
    function finish(event){if(!drag)return;if(event.type==='pointercancel'){width=drag.width;collapsed=drag.collapsed;}drag=null;document.body.classList.remove('workspace-sidebar-resizing');save();sync();}
    splitter.onpointerup=finish;splitter.onpointercancel=finish;splitter.onlostpointercapture=finish;
    const projectAnchor=target=>target.closest?.('.workspace-project-heading>a');
    nav.addEventListener('pointerover',event=>{const a=projectAnchor(event.target);if(isRail()&&a&&event.pointerType!=='touch')show(a);});
    nav.addEventListener('pointerout',event=>{if(projectAnchor(event.target))scheduleClose();});
    nav.addEventListener('focusin',event=>{const a=projectAnchor(event.target);if(isRail()&&a&&!suppressFocus)show(a);});
    nav.addEventListener('focusout',scheduleClose);
    flyout.onpointerenter=()=>{reveal();flyout.querySelector('button')?.setAttribute('aria-expanded','true');};flyout.onpointerleave=scheduleClose;flyout.onfocusin=reveal;flyout.onfocusout=scheduleClose;
    document.addEventListener('click',event=>{const a=projectAnchor(event.target);if(isRail()&&a&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();show(a,true);flyout.querySelector('a')?.focus();}else if(!flyout.contains(event.target))close();},true);
    document.addEventListener('keydown',event=>{if(!isRail())return;const a=projectAnchor(event.target);if(event.key==='Tab'&&event.shiftKey&&event.target===flyout.querySelector('a')){event.preventDefault();close(true);return;}if(event.key==='Tab'&&!event.shiftKey&&event.target===flyout.querySelector('a:last-child')){const nodes=[...nav.querySelectorAll('a,button,input')].filter(n=>n.getClientRects().length),next=nodes[nodes.indexOf(trigger)+1];if(next){event.preventDefault();close();next.focus();return;}}if(a&&[' ','ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();show(a,true);flyout.querySelector('a').focus();}else if(event.key==='Tab'&&!event.shiftKey&&a&&!flyout.hidden){event.preventDefault();reveal();flyout.querySelector('a').focus();}else if(event.key==='Escape'&&!flyout.hidden){event.preventDefault();event.stopImmediatePropagation();close(true);}},true);
    $('crProjectLinks').addEventListener('scroll',()=>{if(!flyout.contains(document.activeElement))close();else position();});
    window.addEventListener('resize',sync);sync();return {sync,close};
  }
  let releasePollBusy=false;
  async function checkFrontendUpdate(){
    if(releasePollBusy||document.hidden||!mounted)return;releasePollBusy=true;
    try{const response=await engine.api('/api/version');if(!response.ok)return;const current=await response.json(),loaded=window.X056_RELEASE?.ui?.fingerprint;
      if(loaded&&current.ui?.fingerprint!==loaded&&!$('workspaceUpdateNotice')){const notice=document.createElement('span');notice.id='workspaceUpdateNotice';notice.className='workspace-update-notice';notice.setAttribute('role','status');notice.textContent='UI update available';notice.title='Refresh when ready. This tab will keep using its current UI until then.';document.querySelector('.cr-top').append(notice);}
    }catch{}finally{releasePollBusy=false;}
  }
  setInterval(checkFrontendUpdate,30000);
  document.addEventListener('visibilitychange',checkFrontendUpdate);
  function connections() {
    const host=$('workspaceConnections');
    const projectGroups=spaces.list().filter(p=>!p.archivedAt).map(space=>({id:space.id,name:space.name,items:[]})),outside={name:'Outside Projects',items:[]};
    for(const project of engine.state().projects)for(const conversation of project.conversations||[]){
      const item={project,conversation},spaceId=spaces.scopeOf(project,conversation.sessionId),group=projectGroups.find(entry=>entry.id===spaceId);
      (group||outside).items.push(item);
    }
    const options=[...projectGroups,outside].filter(group=>group.items.length).map(group=>'<optgroup label="'+esc(group.name)+'">'+group.items.sort((a,b)=>(a.conversation.title||'').localeCompare(b.conversation.title||'')).map(({project,conversation})=>'<option value="'+esc(JSON.stringify([project.id,conversation.sessionId]))+'">'+esc(conversation.title)+' · '+esc(project.name)+'</option>').join('')+'</optgroup>').join('');
    host.innerHTML='<div class="cr-heading"><div><h1>Accounts & tools</h1><p>Plugins, MCP servers, and skills available to your conversations.</p></div></div><div class="workspace-section-heading"><h2>Conversation tools</h2></div><p class="rc-space-note">Choose a conversation to open its available tools.</p><form id="workspaceToolChoice" class="workspace-form"><label>Conversation<select name="conversation" required><option value="">Choose a conversation</option>'+options+'</select></label></form>';
    const select=$('workspaceToolChoice').elements.conversation;try{select.value=localStorage.getItem('x056_tools_conversation')||'';}catch{}
    select.onchange=e=>{const value=e.target.value;if(value){try{localStorage.setItem('x056_tools_conversation',value);}catch{}const [projectId,sessionId]=JSON.parse(value);chat.tools({projectId,sessionId});}};
  }
  async function navigate(url,replace=false) {
    if(!mounted)return spaces?.navigate(url);
    const target=canonical(url);if(target!==url){replace=location.pathname===url||replace;url=target;}
    const serial=++routeSerial;
    if(location.pathname!==url){if(room.isOpen()===false)returnPath=location.pathname;history[replace?'replaceState':'pushState']({},'',url);}
    activeRoute=url;sidebar?.close();closeDrawer();
    document.querySelectorAll('#workspaceFileMenu:popover-open').forEach(p=>p.hidePopover());
    if(!settingsRoute(url))room.mountSettings(null);
    if(!handles(url)){enteredPage=null;await spaces.navigate(url);if(serial===routeSerial)renderNav();return;}
    spaces.leave();chat?.leave(false,true);room.showPage(globals[url]==='connections'||globals[url]==='preferences'?'board':globals[url]);
    if(globals[url]==='board')room.selectWorkScope('');
    if(url==='/accounts/tools'||settingsRoute(url)){$('crBoard').hidden=true;if(url==='/accounts/tools')connections();}
    if(settingsRoute(url))room.mountSettings($('workspaceSettingsBody'),sectionOf(url));
    renderNav();room.refresh();
    const shown=[...document.querySelectorAll('#crWorkspace>.cr-page')].find(n=>!n.hidden);
    if(shown&&shown!==enteredPage){enteredPage=shown;window.rcMotion?.enter(shown);window.rcMotion?.list(shown);}
  }
  function closeConversation() {
    const stateReturn = typeof history.state?.returnTo === 'string' ? history.state.returnTo : '';
    const fallback = spaces?.returnForConversation?.(engine.state().projectId, engine.state().sessionId) || returnPath || '/home';
    const destination = stateReturn && stateReturn !== location.pathname ? stateReturn : fallback;
    return navigate(destination, true);
  }
  function sectionChanged(next){
    if(!mounted)return;const url={board:'/home',accounts:'/accounts',automations:'/activity/automations',artifacts:'/activity/outputs',planner:'/activity/queue',memory:'/memory'}[next];
    if(url){spaces.leave();if(location.pathname!==url)history.pushState({},'',url);activeRoute=url;renderNav();}
  }
  function sync(){if(!mounted)return;clearTimeout(renderTimer);renderTimer=setTimeout(renderNav,40);}
  document.addEventListener('x056:state',sync);document.addEventListener('x056:mode',sync);
  window.addEventListener('resize',sync);
  window.addEventListener('popstate',()=>{if(mounted&&handles(location.pathname)&&activeRoute!==location.pathname)navigate(location.pathname,true);else sync();});
  const openSettings=tab=>navigate((settingsSections.find(([,,key])=>key===tab)||settingsSections[0])[0]).catch(e=>room.notify(e.message));
  return {ready:()=>mounted,handles,renderNav,context,navigate,closeConversation,sectionChanged,openSettings,init:async()=>{if(!spaces?.enabled())return;mount();if(handles(location.pathname))await navigate(location.pathname,true);else renderNav();room.refresh();}};
};
