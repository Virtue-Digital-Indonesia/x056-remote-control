/* Project navigation around the existing authenticated conversation surfaces. */
window.createProjectWorkspace = function(engine, room, chat, spaces) {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=n=>`<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const globals={'/':'board','/home':'board','/dashboard':'accounts','/activity':'board','/accounts':'connections','/automations':'automations','/artifacts':'artifacts','/queue':'planner','/memory':'memory','/settings':'preferences','/work/unassigned':'board'};
  const labels={'/':'Home','/home':'Home','/dashboard':'Dashboard','/activity':'Activity','/accounts':'Accounts & tools','/automations':'Automations','/artifacts':'Artifacts','/queue':'Queue planner','/memory':'Workspace memory','/settings':'Settings','/work/unassigned':'Unassigned Work'};
  const link=(url,text,cls='')=>`<a href="${esc(url)}" data-workspace-link class="${cls}">${text}</a>`;
  let mounted=false,navSignature='',navContext='',renderTimer,routeSerial=0,activeRoute='',returnPath='/home';
  const handles=p=>Object.hasOwn(globals,p);
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
    const markup=projects.filter(p=>p.name.toLowerCase().includes(query)).map(p=>sidebarItem('/projects/'+encodeURIComponent(p.id)+'/overview',p.name,'folder',false,current.id===p.id?icon('down'):p.activity?.needsInput?`<small class="attention">${p.activity.needsInput}</small>`:'')+(current.id===p.id?`<div class="workspace-project-children">${[['overview','Overview','menu'],['chat','Chat','chat'],['work','Work','terminal'],['files','Files','file'],['memory','Memory','snippet']].map(([tab,name,ic])=>sidebarItem('/projects/'+encodeURIComponent(p.id)+'/'+tab,name,ic,tab===current.tab,['chat','work'].includes(tab)?`<small>${(p.members||[]).filter(m=>m.mode===tab).length}</small>`:'')).join('')}</div>`:'')).join('')||'<p class="workspace-nav-empty">No matching Projects</p>';
    if(navSignature!==markup){navSignature=markup;const focused=document.activeElement?.closest('#crProjectLinks a')?.getAttribute('href');$('crProjectLinks').innerHTML=markup;if(focused)[...$('crProjectLinks').querySelectorAll('a')].find(a=>a.getAttribute('href')===focused)?.focus({preventScroll:true});}
    const nextContext=(current.id||'')+'/'+(current.tab||'');
    if(navContext!==nextContext){navContext=nextContext;const selected=$('crProjectLinks').querySelector('[aria-current=page]');if(selected){const container=$('crProjectLinks'),a=selected.getBoundingClientRect(),b=container.getBoundingClientRect();if(a.bottom>b.bottom)container.scrollTop+=a.bottom-b.bottom+8;else if(a.top<b.top)container.scrollTop-=b.top-a.top+8;}}
    const pathname=location.pathname;
    document.querySelectorAll('[data-global-destination]').forEach(a=>{const selected=a.getAttribute('href')===pathname||(pathname==='/'&&a.getAttribute('href')==='/home');if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const p=projects.find(p=>p.id===current.id);
    const name=p?.name||labels[pathname]||(pathname==='/projects'?'All Projects':pathname.startsWith('/chat')?'Chat':pathname.startsWith('/work')?'Work':'Workspace');
    $('crBreadcrumb').innerHTML=link('/home','Workspace')+` <span>/</span> `+(p?link('/projects/'+encodeURIComponent(p.id)+'/overview',esc(name))+` <span>/ ${esc(current.tab[0].toUpperCase()+current.tab.slice(1))}</span>`:`<span>${esc(name)}</span>`);
    if(document.body.dataset.chatMode==='page')$('controlRoom').inert=false;
    const drawerOpen=innerWidth<=850&&$('controlRoom').classList.contains('projects-open');
    document.querySelectorAll('#crWorkspace>.cr-page').forEach(n=>n.inert=document.body.dataset.chatMode==='page'||drawerOpen);
    if(document.body.dataset.chatMode==='page')$('conversationSurface').inert=drawerOpen;else $('conversationSurface').inert=false;
    const isGlobal=handles(pathname),boardVisible=['/','/home','/activity','/work/unassigned'].includes(pathname);
    $('workspaceActivityLinks').hidden=!boardVisible;
    $('workspaceConnections').hidden=pathname!=='/accounts';$('workspacePreferences').hidden=pathname!=='/settings';
    if(!isGlobal){$('workspaceConnections').hidden=true;$('workspacePreferences').hidden=true;}
    // The old list remains the /chat library. Conversation pages use the same
    // parent navigation as Work and retain their transcript/composer nodes.
    if($('rcChatHome')){$('rcChatHome').innerHTML='<h1>Chat</h1>';}
    if($('rcChatControl'))$('rcChatControl').textContent='Home';
    $('workspaceStandalone').setAttribute('aria-current',pathname==='/chat'?'page':'false');
  }
  function closeDrawer(){
    $('controlRoom').classList.remove('projects-open');$('crProjectVeil').hidden=true;$('crProjects').setAttribute('aria-expanded','false');
    $('crProjectNav').inert=innerWidth<=850;
    document.querySelectorAll('#crWorkspace>.cr-page').forEach(n=>n.inert=false);
    $('conversationSurface').inert=false;
  }
  function mount() {
    if(mounted)return;mounted=true;document.body.classList.add('rc-workspace-ready');
    const nav=$('crProjectNav'),primary=nav.querySelector('.cr-primary-nav');
    nav.insertAdjacentHTML('afterbegin',link('/home','<b>x0</b><span>Remote Control</span>','workspace-brand')+'<button id="workspaceSearch" class="workspace-search">'+icon('search')+' Search anything <kbd>⌘ K</kbd></button>');
    $('workspaceSearch').onclick=()=>$('searchChatsBtn').click();
    const destinations=[['crHomeTab','/home','Home','menu'],['crSpacesTab','/projects','All Projects','folder'],['crAccountsTab','/dashboard','Dashboard','chart'],['workspaceActivity','/activity','Activity','sparkles'],['crAutomationsTab','/automations','Automations','alarm'],['workspaceAccountsTab','/accounts','Accounts & tools','plug'],['crArtifactsTab','/artifacts','Artifacts','file'],['crPlannerTab','/queue','Queue planner','menu'],['crMemoryTab','/memory','Workspace memory','snippet'],['sidebarSettings','/settings','Settings','gear']];
    const bottom=document.createElement('nav');bottom.className='cr-primary-nav workspace-global-nav';bottom.setAttribute('aria-label','Workspace tools');nav.append(bottom);
    for(const [id,url,label,ic] of destinations){let a=document.createElement('a');a.id=id;a.href=url;a.dataset.workspaceLink='';a.dataset.globalDestination='';a.innerHTML=icon(ic)+'<span>'+label+'</span>';const old=$(id);if(old)old.replaceWith(a);(url==='/home'||url==='/projects'?primary:bottom).append(a);}
    // Preserve the all-Work route and repository management without listing every
    // repository a second time in the Project sidebar.
    $('crBoardTab').hidden=true;$('crChatTab').hidden=true;$('crManageProjects').hidden=true;
    nav.querySelector('header span').textContent='PROJECTS';
    const outside=document.createElement('div');outside.className='workspace-outside';outside.innerHTML='<span>CONVERSATION LIBRARY</span>'+sidebarItem('/chat','All Chats','chat')+sidebarItem('/work/unassigned','Unassigned Work','terminal');nav.insertBefore(outside,bottom);outside.querySelector('a').id='workspaceStandalone';
    $('crProjects').setAttribute('aria-label','Open workspace navigation');$('crProjects').setAttribute('aria-controls','crProjectNav');
    $('crProjects').addEventListener('click',renderNav);$('crProjectVeil').addEventListener('click',renderNav);
    $('crHome').hidden=true;
    $('crBoard').querySelector('.cr-heading').insertAdjacentHTML('afterend','<nav id="workspaceActivityLinks" class="workspace-activity-links" aria-label="Activity views">'+link('/activity','Conversations')+link('/queue','Queued messages')+link('/automations','Automations')+link('/artifacts','Outputs')+link('/work','All Work repositories')+'</nav>');
    $('crWorkspace').insertAdjacentHTML('beforeend','<section id="workspaceConnections" class="cr-page" hidden></section><section id="workspacePreferences" class="cr-page" hidden></section>');
    const settings=$('workspacePreferences');settings.innerHTML='<div class="cr-heading"><div><h1>Settings</h1><p>Workspace preferences, routing, connections, and security.</p></div></div><div class="workspace-settings-list">'+[['general','Appearance & conversations','Theme, labels, display preferences, and the floating switcher.'],['models','Model defaults','Provider and reasoning effort defaults.'],['routing','Account routing','Account selection and failover preferences.'],['connections','Connections','Connected providers and services.'],['security','Security','Sign-in, passkeys, and access settings.']].map(([key,title,detail])=>'<button data-settings-page="'+key+'"><span><strong>'+title+'</strong><small>'+detail+'</small></span>'+icon('right')+'</button>').join('')+'</div>';
    settings.querySelectorAll('[data-settings-page]').forEach(b=>b.onclick=()=>room.showSettings(b.dataset.settingsPage));
    $('crNew').addEventListener('click',event=>{if(['/','/home','/activity'].includes(location.pathname)){event.preventDefault();event.stopImmediatePropagation();chat.newChat();}},true);
    // These controls have older listeners; capture ensures one route transition.
    document.addEventListener('click',event=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const a=event.target.closest('a[data-workspace-link]');
      const home=event.target.closest('#focusHome,#focusBack,#crHome,#chatClose');
      if(a){event.preventDefault();event.stopImmediatePropagation();a.closest('dialog')?.close();navigate(new URL(a.href).pathname).catch(e=>room.notify(e.message));}
      else if(home){event.preventDefault();event.stopImmediatePropagation();navigate(home.id==='chatClose'?returnPath:'/home').catch(e=>room.notify(e.message));}
    },true);
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&$('controlRoom').classList.contains('projects-open')){event.preventDefault();closeDrawer();$('crProjects').focus();}
      if(event.key==='Tab'&&innerWidth<=850&&$('controlRoom').classList.contains('projects-open')){const nodes=[...nav.querySelectorAll('a,button,input')].filter(n=>n.getClientRects().length),first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    });
  }
  function connections() {
    const host=$('workspaceConnections'),accounts=engine.state().accounts;
    host.innerHTML='<div class="cr-heading"><div><h1>Accounts & tools</h1><p>Provider accounts and the tools available to each conversation.</p></div><button class="cr-primary" id="workspaceConnect">'+icon('plus')+' Connect account</button></div><div class="workspace-account-list">'+accounts.map(a=>'<article><span class="workspace-account-mark">'+icon('user')+'</span><div><strong>'+esc(a.label||a.displayName||a.name)+'</strong><small>'+esc(a.provider==='codex'?'Codex':'Claude')+' · '+esc(a.name)+'</small></div><button class="cr-secondary" data-account-name="'+esc(a.name)+'">Manage</button></article>').join('')+'</div><div class="workspace-section-heading"><h2>Plugins, MCP, and Skills</h2></div><p class="rc-space-note">Tools depend on the provider, account, Project requirements, and execution directory. Choose a conversation to inspect its available tools.</p><form id="workspaceToolChoice" class="workspace-form"><label>Conversation<select name="conversation" required><option value="">Choose a conversation</option>'+engine.state().projects.flatMap(p=>(p.conversations||[]).map(c=>'<option value="'+esc(JSON.stringify([p.id,c.sessionId]))+'">'+esc(c.title)+' · '+esc(p.name)+'</option>')).join('')+'</select></label><button class="cr-secondary">Open tools</button></form><p class="rc-space-note">'+link('/dashboard','View usage, account limits, charts, and costs in Dashboard.')+'</p>';
    $('workspaceConnect').onclick=()=>$('addAcctBtn').click();
    host.querySelectorAll('[data-account-name]').forEach(b=>b.onclick=()=>room.showAccounts());
    $('workspaceToolChoice').onsubmit=e=>{e.preventDefault();const value=e.target.elements.conversation.value;if(value){const [pid]=JSON.parse(value);chat.tools(pid);}};
  }
  async function navigate(url,replace=false) {
    if(!mounted)return spaces?.navigate(url);
    const serial=++routeSerial;
    if(location.pathname!==url){if(room.isOpen()===false)returnPath=location.pathname;history[replace?'replaceState':'pushState']({},'',url);}
    activeRoute=url;closeDrawer();
    document.querySelectorAll('#workspaceFileMenu:popover-open').forEach(p=>p.hidePopover());
    if(!handles(url)){await spaces.navigate(url);if(serial===routeSerial)renderNav();return;}
    spaces.leave();chat?.leave(false,true);room.showPage(globals[url]==='connections'||globals[url]==='preferences'?'board':globals[url]);
    if(globals[url]==='board')room.selectWorkScope('');
    if(url==='/accounts'||url==='/settings'){$('crBoard').hidden=true;if(url==='/accounts')connections();}
    renderNav();room.refresh();
  }
  function sectionChanged(next){
    if(!mounted)return;const url={board:'/home',accounts:'/dashboard',automations:'/automations',artifacts:'/artifacts',planner:'/queue',memory:'/memory'}[next];
    if(url){spaces.leave();if(location.pathname!==url)history.pushState({},'',url);activeRoute=url;renderNav();}
  }
  function sync(){if(!mounted)return;clearTimeout(renderTimer);renderTimer=setTimeout(renderNav,40);}
  document.addEventListener('x056:state',sync);document.addEventListener('x056:mode',sync);
  window.addEventListener('resize',sync);
  window.addEventListener('popstate',()=>{if(mounted&&handles(location.pathname)&&activeRoute!==location.pathname)navigate(location.pathname,true);else sync();});
  return {ready:()=>mounted,handles,renderNav,context,navigate,sectionChanged,init:async()=>{if(!spaces?.enabled())return;mount();if(handles(location.pathname))await navigate(location.pathname,true);else renderNav();room.refresh();}};
};
