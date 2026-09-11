/* Project navigation around the existing authenticated conversation surfaces. */
window.createProjectWorkspace = function(engine, room, chat, spaces) {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=n=>`<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const settingsSections=[['/settings','General','general'],['/settings/models','Models','models'],['/settings/routing','Routing','routing'],['/settings/connections','Connections','connections'],['/settings/security','Security','security']];
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
  let mounted=false,navSignature='',navContext='',renderTimer,routeSerial=0,activeRoute='',returnPath='/home';
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
    const markup=projects.filter(p=>p.name.toLowerCase().includes(query)).map(p=>sidebarItem('/projects/'+encodeURIComponent(p.id)+'/overview',p.name,'folder',false,current.id===p.id?icon('down'):p.activity?.needsInput?`<small class="attention">${p.activity.needsInput}</small>`:'')+(current.id===p.id?`<div class="workspace-project-children">${[['overview','Overview','menu'],['chat','Chat','chat'],['work','Work','terminal'],['files','Files','file'],['memory','Memory','snippet']].map(([tab,name,ic])=>sidebarItem('/projects/'+encodeURIComponent(p.id)+'/'+tab,name,ic,tab===current.tab,['chat','work'].includes(tab)?`<small>${(p.members||[]).filter(m=>m.mode===tab).length}</small>`:'')).join('')}</div>`:'')).join('')||'<p class="workspace-nav-empty">No matching Projects</p>';
    if(navSignature!==markup){navSignature=markup;const focused=document.activeElement?.closest('#crProjectLinks a')?.getAttribute('href');$('crProjectLinks').innerHTML=markup;if(focused)[...$('crProjectLinks').querySelectorAll('a')].find(a=>a.getAttribute('href')===focused)?.focus({preventScroll:true});}
    const nextContext=(current.id||'')+'/'+(current.tab||'');
    if(navContext!==nextContext){navContext=nextContext;const selected=$('crProjectLinks').querySelector('[aria-current=page]');if(selected){const container=$('crProjectLinks'),a=selected.getBoundingClientRect(),b=container.getBoundingClientRect();if(a.bottom>b.bottom)container.scrollTop+=a.bottom-b.bottom+8;else if(a.top<b.top)container.scrollTop-=b.top-a.top+8;}}
    const pathname=location.pathname;
    document.querySelectorAll('[data-global-destination]').forEach(a=>{const href=a.getAttribute('href'),selected=href===pathname||(pathname==='/'&&href==='/home')||(['/activity','/accounts'].includes(href)&&pathname.startsWith(href+'/'));if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const p=projects.find(p=>p.id===current.id);
    const name=p?.name||labels[pathname]||(pathname==='/projects'?'All Projects':pathname.startsWith('/chat')?'Chat':pathname.startsWith('/work')?'Work':'Workspace');
    $('crBreadcrumb').innerHTML=link('/home','Workspace')+SEP+(p?link('/projects/'+encodeURIComponent(p.id)+'/overview',esc(name))+SEP+`<span>${esc(current.tab[0].toUpperCase()+current.tab.slice(1))}</span>`:`<span>${esc(name)}</span>`);
    if(document.body.dataset.chatMode==='page')$('controlRoom').inert=false;
    const drawerOpen=innerWidth<=850&&$('controlRoom').classList.contains('projects-open');
    document.querySelectorAll('#crWorkspace>.cr-page').forEach(n=>n.inert=document.body.dataset.chatMode==='page'||drawerOpen);
    if(document.body.dataset.chatMode==='page')$('conversationSurface').inert=drawerOpen;else $('conversationSurface').inert=false;
    const isGlobal=handles(pathname),home=['/','/home'].includes(pathname),activity=pathname==='/activity'||pathname.startsWith('/activity/');
    const activityViews=[['/activity','Conversations'],['/activity/queue','Queued messages'],['/activity/automations','Automations'],['/activity/outputs','Outputs']];
    viewNav($('crBoard'),activity?activityViews:[['/home','Recent'],['/chat','All Chats'],['/work/unassigned','Unassigned Work'],['/work','Work repositories']],'Conversation views');
    $('crBoard').querySelector('.workspace-view-nav').hidden=!home&&!activity&&pathname!=='/work/unassigned';
    for(const id of ['crPlanner','crAutomations','crArtifacts']){viewNav($(id),activityViews,'Activity views');$(id).querySelector('.cr-heading h1').textContent='Activity';}
    const accountViews=[['/accounts','Accounts & usage'],['/accounts/tools','Tools']];
    if($('accountProvider')){viewNav($('crAccounts'),accountViews,'Account views');$('crAccounts').querySelector('.cr-heading h1').textContent='Accounts & tools';$('crAccounts').querySelector('.cr-heading p').textContent='Provider accounts, usage charts, and estimated spend.';}
    if($('workspaceConnections').querySelector('.cr-heading'))viewNav($('workspaceConnections'),accountViews,'Account views');
    $('crNew').hidden=activity;
    if(home)$('crNew').innerHTML=icon('plus')+' New Chat';else $('crNew').innerHTML=icon('plus')+' New conversation';
    if($('workspaceSettingsBody'))viewNav($('workspacePreferences'),settingsSections.map(([url,name])=>[url,name]),'Settings sections');
    $('workspaceConnections').hidden=pathname!=='/accounts/tools';$('workspacePreferences').hidden=!settingsRoute(pathname);
    if(!isGlobal){$('workspaceConnections').hidden=true;$('workspacePreferences').hidden=true;}
    // The old list remains the /chat library. Conversation pages use the same
    // parent navigation as Work and retain their transcript/composer nodes.
    if($('rcChatHome')){$('rcChatHome').innerHTML='<h1>Chat</h1>';}
    if($('rcChatControl'))$('rcChatControl').textContent='Home';
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
    const destinations=[['crHomeTab','/home','Home','menu'],['crSpacesTab','/projects','All Projects','folder'],['workspaceActivity','/activity','Activity','sparkles'],['crAccountsTab','/accounts','Accounts & tools','plug'],['crMemoryTab','/memory','Workspace memory','snippet'],['sidebarSettings','/settings','Settings','gear']];
    const bottom=document.createElement('nav');bottom.className='cr-primary-nav workspace-global-nav';bottom.setAttribute('aria-label','Workspace tools');nav.append(bottom);
    for(const [id,url,label,ic] of destinations){let a=document.createElement('a');a.id=id;a.href=url;a.dataset.workspaceLink='';a.dataset.globalDestination='';a.innerHTML=icon(ic)+'<span>'+label+'</span>';const old=$(id);if(old)old.replaceWith(a);(url==='/home'||url==='/projects'?primary:bottom).append(a);}
    // Preserve the all-Work route and repository management without listing every
    // repository a second time in the Project sidebar.
    for(const id of ['crBoardTab','crChatTab','crManageProjects','crAutomationsTab','crArtifactsTab','crPlannerTab','crSettings'])$(id).hidden=true;
    nav.querySelector('header span').textContent='PROJECTS';
    $('crProjects').setAttribute('aria-label','Open workspace navigation');$('crProjects').setAttribute('aria-controls','crProjectNav');
    $('crProjects').addEventListener('click',renderNav);$('crProjectVeil').addEventListener('click',renderNav);
    $('crHome').hidden=true;
    $('crWorkspace').insertAdjacentHTML('beforeend','<section id="workspaceConnections" class="cr-page" hidden></section><section id="workspacePreferences" class="cr-page" hidden></section>');
    $('workspacePreferences').innerHTML='<div class="cr-heading"><div><h1>Settings</h1><p>Workspace preferences, routing, connections, and security.</p></div></div><div id="workspaceSettingsBody" class="workspace-settings-body"></div>';
    $('crNew').addEventListener('click',event=>{if(['/','/home'].includes(location.pathname)){event.preventDefault();event.stopImmediatePropagation();chat.newChat();}},true);
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
    const host=$('workspaceConnections');
    host.innerHTML='<div class="cr-heading"><div><h1>Accounts & tools</h1><p>Plugins, MCP servers, and skills available to your conversations.</p></div></div><div class="workspace-section-heading"><h2>Conversation tools</h2></div><p class="rc-space-note">Choose a conversation to see the tools available through its provider and account.</p><form id="workspaceToolChoice" class="workspace-form"><label>Conversation<select name="conversation" required><option value="">Choose a conversation</option>'+engine.state().projects.flatMap(p=>(p.conversations||[]).map(c=>'<option value="'+esc(JSON.stringify([p.id,c.sessionId]))+'">'+esc(c.title)+' · '+esc(p.name)+'</option>')).join('')+'</select></label><button class="cr-secondary">Open tools</button></form>';
    $('workspaceToolChoice').onsubmit=e=>{e.preventDefault();const value=e.target.elements.conversation.value;if(value){const [pid]=JSON.parse(value);chat.tools(pid);}};
  }
  async function navigate(url,replace=false) {
    if(!mounted)return spaces?.navigate(url);
    const target=canonical(url);if(target!==url){replace=location.pathname===url||replace;url=target;}
    const serial=++routeSerial;
    if(location.pathname!==url){if(room.isOpen()===false)returnPath=location.pathname;history[replace?'replaceState':'pushState']({},'',url);}
    activeRoute=url;closeDrawer();
    document.querySelectorAll('#workspaceFileMenu:popover-open').forEach(p=>p.hidePopover());
    if(!settingsRoute(url))room.mountSettings(null);
    if(!handles(url)){await spaces.navigate(url);if(serial===routeSerial)renderNav();return;}
    spaces.leave();chat?.leave(false,true);room.showPage(globals[url]==='connections'||globals[url]==='preferences'?'board':globals[url]);
    if(globals[url]==='board')room.selectWorkScope('');
    if(url==='/accounts/tools'||settingsRoute(url)){$('crBoard').hidden=true;if(url==='/accounts/tools')connections();}
    if(settingsRoute(url))room.mountSettings($('workspaceSettingsBody'),sectionOf(url));
    renderNav();room.refresh();
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
  return {ready:()=>mounted,handles,renderNav,context,navigate,sectionChanged,openSettings,init:async()=>{if(!spaces?.enabled())return;mount();if(handles(location.pathname))await navigate(location.pathname,true);else renderNav();room.refresh();}};
};
