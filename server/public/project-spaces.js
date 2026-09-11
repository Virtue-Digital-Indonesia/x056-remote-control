/* Parent Project views reuse the mounted conversation, memory and file services. */
window.createProjectSpaces = function (engine, room, chat) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const path = (id, tab = 'overview') => '/projects' + (id ? '/' + encodeURIComponent(id) + '/' + tab : '');
  const conversationPath = (p, sid) => p.kind === 'chat' ? '/chat/' + encodeURIComponent(p.id) : '/work/' + encodeURIComponent(p.id) + '/' + encodeURIComponent(sid);
  const handles = pathname => /^\/(projects|work)(\/|$)/.test(pathname) || !!window.rcWorkspace?.handles(pathname);
  let registryRevision = 0, topology = '';
  let enabled = false, mounted = false, projects = [], activeId = '', activeTab = '', generation = 0, navigating = false;
  const uploads = new Map();
  const request = async (url, body) => {
    const response = await engine.api(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Request failed'); return data;
  };
  const base = id => '/api/project-spaces/' + encodeURIComponent(id);
  const action = work => async event => { try { await work(event); } catch (error) { room.notify(error.message); } };
  const link = (url, label, cls = '') => `<a class="${cls}" href="${esc(url)}" data-space-link>${label}</a>`;
  function dialog(title, body) {
    const d = document.createElement('dialog'); d.className = 'cr-dialog rc-space-dialog';
    const label = 'space-dialog-' + crypto.randomUUID(); d.setAttribute('aria-labelledby', label);
    d.innerHTML = `<header><h2 id="${label}">${esc(title)}</h2><button class="cr-icon" type="button" aria-label="Close" title="Close">${icon('x')}</button></header>${body}`;
    d.querySelector('header button').onclick = () => d.close();
    d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
    d.onclose = () => d.remove(); document.body.append(d); d.showModal(); return d;
  }
  function mount() {
    if (mounted) return; mounted = true;
    $('crBoardTab').insertAdjacentHTML('beforebegin', link('/projects', icon('folder') + '<span>Projects</span>', 'rc-project-nav-link'));
    document.querySelector('.rc-project-nav-link').id = 'crSpacesTab';$('crSpacesTab').hidden=!enabled;
    const panel = document.createElement('section'); panel.id = 'rcProjectPage'; panel.className = 'cr-page'; panel.hidden = true; $('crWorkspace').append(panel);
    $('crBoardTab').innerHTML = icon('menu') + '<span>Work</span>';
    const work = document.createElement('a'); for (const attr of $('crBoardTab').attributes) work.setAttribute(attr.name, attr.value);
    work.href = '/work'; work.dataset.spaceLink = ''; work.innerHTML = $('crBoardTab').innerHTML; $('crBoardTab').replaceWith(work);
    room.refresh(); if(enabled)updateChatFilter();
  }
  function restoreMemory() { const memory = $('crMemory'); $('rcProjectBrief')?.remove(); if($('memoryProject'))$('memoryProject').disabled=false; if (memory && memory.parentNode !== $('crWorkspace')) $('crWorkspace').append(memory); }
  function leave() {
    restoreMemory(); document.body.classList.remove('rc-spaces-view'); $('rcProjectPage').hidden = true;
    $('crSpacesTab').removeAttribute('aria-current');if($('crBreadcrumb'))$('crBreadcrumb').innerHTML='Workspace<span class="crumb-sep">/</span><span>Work</span>';
  }
  async function navigate(url, replace = false) {
    if (location.pathname !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
    if (url.startsWith('/chat')) { generation++;leave(); return chat?.navigate(url); }
    return route();
  }
  async function load() { const result = await request('/api/project-spaces'); projects = result.projects || []; registryRevision = result.revision; topology = result.topology; if(mounted&&enabled)updateChatFilter(); return result; }
  function updateChatFilter() {
    if(!$('rcChatSearch'))return; let select=$('rcChatProjectFilter');
    if(!select){select=document.createElement('select');select.id='rcChatProjectFilter';select.setAttribute('aria-label','Filter chats by project');$('rcChatSearch').after(select);select.onchange=()=>chat.refresh();}
    const selected=select.value;select.innerHTML='<option value="">All Chat</option><option value="standalone">Standalone Chat</option>'+projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');select.value=selected;chat.refresh();
  }
  async function route() {
    const version = ++generation, url = location.pathname;
    if(window.rcWorkspace?.handles(url)){if(window.rcWorkspace.ready())return window.rcWorkspace.navigate(url,true);leave();return;}
    if (!handles(url)) { leave(); updateContext(); return; }
    navigating = true;
    try {
      chat?.leave(false, true); restoreMemory();
      const segments = url.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments[0] === 'work') {
        leave();
        if (segments.length === 3) {
          await engine.reloadProjects(); if (generation !== version) return;
          const p = engine.state().projects.find(p => p.id === segments[1] && p.kind !== 'chat');
          if (!p || !p.conversations?.some(c => c.sessionId === segments[2])) throw new Error('Work conversation unavailable');
          await engine.select(p.id, segments[2]); if (generation !== version) return;
          room.openChat(); engine.markRead(); updateContext();
        } else { await engine.reloadProjects(); if(generation!==version)return;if(segments[1]&&segments[1]!=='unassigned'&&!engine.state().projects.some(p=>p.id===segments[1]&&p.kind!=='chat'))throw new Error('Work project unavailable'); room.showBoard(); room.selectWorkScope(segments[1]==='unassigned'?'':segments[1] || ''); $('crBoardTab').setAttribute('aria-current', 'page'); }
        return;
      }
      if(!enabled)throw new Error('Project spaces are disabled. Existing Work and Chat remain available.');
      room.showBoard(); document.body.classList.add('rc-spaces-view'); $('rcProjectPage').hidden = false;
      $('crSpacesTab').setAttribute('aria-current', 'page'); $('crBoardTab').removeAttribute('aria-current');
      $('rcProjectPage').innerHTML = '<p class="cr-empty" role="status">Loading Project…</p>';
      await load(); if (generation !== version || location.pathname !== url) return;
      activeId = segments[1] || ''; activeTab = segments[2] || 'overview';if($('crBreadcrumb'))$('crBreadcrumb').innerHTML=link('/projects','Projects')+'<span class="crumb-sep">/</span><span>'+esc(projects.find(p=>p.id===activeId)?.name||'All projects')+'</span>';room.refresh();
      if (!activeId) renderList();
      else {
        let project = projects.find(p => p.id === activeId);
        if(!project){project=await request(base(activeId));if(generation!==version)return;activeId=project.id;history.replaceState({},'',path(activeId,activeTab));}
        if (!project) throw new Error('Project unavailable');
        if (!['overview','chat', 'work', 'files', 'memory', 'settings'].includes(activeTab)) throw new Error('Project page unavailable');
        if (segments.length === 2) history.replaceState({}, '', path(activeId));
        await renderProject(project);
      }
      $('rcProjectPage').querySelector('h1')?.focus({ preventScroll: true });
    } catch (error) {
      room.showBoard(); document.body.classList.add('rc-spaces-view'); $('rcProjectPage').hidden = false;
      $('rcProjectPage').innerHTML = `<div class="cr-empty" role="alert"><h1 tabindex="-1">Page unavailable</h1><p>${esc(error.message)}</p>${link(enabled?'/projects':'/work',enabled?'Open Projects':'Open Work','cr-secondary')}</div>`;
    } finally { navigating = false; updateContext(); window.rcWorkspace?.renderNav(); }
  }
  function renderList() {
    $('rcProjectPage').innerHTML = `<div class="cr-heading"><div><h1 tabindex="-1">Projects</h1><p>A shared home for conversations, files, and reviewed memory.</p></div><button class="cr-primary" id="rcSpaceNew">${icon('plus')} New project</button></div><div class="rc-space-list-controls"><label class="cr-search">${icon('search')}<input id="rcSpaceSearch" type="search" placeholder="Find a project" aria-label="Find a project"></label><label><input id="rcSpaceArchives" type="checkbox"> Show archived</label></div><div class="rc-space-grid" id="rcSpaceList"></div>`;
    const render = () => {
      const query = $('rcSpaceSearch').value.toLowerCase(), archived = $('rcSpaceArchives').checked;
      $('rcSpaceList').innerHTML = projects.filter(p => !!p.archivedAt === archived && p.name.toLowerCase().includes(query)).map(p => link(path(p.id), `${icon('folder')}<h2>${esc(p.name)}</h2><p>${p.chats.length} Chat · ${(p.members || []).filter(m=>m.mode==='work').length} Work</p><small>${p.activity.running || p.activity.background ? `${p.activity.running} running · ${p.activity.background} background` : p.workspaceConfigured ? 'Work workspace ready' : 'Chat and files ready'}</small>`, 'rc-space-card')).join('') || '<p class="cr-empty">No projects found.</p>';
    };
    $('rcSpaceSearch').oninput = $('rcSpaceArchives').onchange = render; $('rcSpaceNew').onclick = createProject; render();
  }
  function createProject(workProjectId) {
    if(typeof workProjectId!=='string')workProjectId=undefined;
    const d = dialog('New project', '<form class="workspace-form"><label>Name<input name="name" required maxlength="300" placeholder="Proposal"></label><p>Start with Chat and Files. Add a Work workspace when you need it.</p><p role="alert"></p><button class="cr-primary">Create project</button></form>');
    const form = d.querySelector('form'), requestId = crypto.randomUUID();
    if(workProjectId){form.querySelector('p').textContent='Create a Project, then review the association with this Work project. The repository stays in place.';form.elements.name.value=engine.state().projects.find(p=>p.id===workProjectId)?.name||'';}
    form.onsubmit = async e => { e.preventDefault(); form.querySelector('button').disabled = true;
      try { const p = await request('/api/project-spaces', { requestId, name: form.elements.name.value }); await engine.reloadProjects(); d.close(); await navigate(path(p.id)); if(workProjectId)await reviewMembership({kind:'work-project',projectId:workProjectId},p.id); }
      catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { form.querySelector('button').disabled = false; }
    };
  }
  async function renderProject(p) {
    $('rcProjectPage').innerHTML = `<div class="rc-space-breadcrumb">${link('/projects', 'Projects')}<span>/</span><span>${esc(p.name)}</span></div><div class="cr-heading"><div><h1 tabindex="-1">${esc(p.name)}</h1><p>${p.archivedAt ? 'Archived · saved history and files are retained' : `${p.activity.running} running · ${p.activity.background} background · ${p.activity.queued} queued · ${p.activity.needsInput} need input`}</p></div><div class="rc-space-toolbar"><button class="cr-secondary" id="rcSpaceAddExisting" ${p.archivedAt?'disabled':''}>${icon('plus')} Add existing</button><button class="cr-secondary" id="rcSpaceCosts">Costs</button>${link(path(p.id, 'settings'), icon('gear') + ' Settings', 'cr-secondary')}</div></div><nav class="rc-space-tabs" aria-label="Project sections">${['overview','chat', 'work', 'files', 'memory'].map(tab => `<a href="${path(p.id, tab)}" data-space-link ${tab === activeTab ? 'aria-current="page"' : ''}>${icon({overview:'menu',chat:'chat',work:'terminal',files:'file',memory:'snippet'}[tab])}${tab[0].toUpperCase() + tab.slice(1)}</a>`).join('')}</nav><div id="rcProjectBody"></div>`;
    $('rcSpaceCosts').onclick=()=>room.showCosts();
    $('rcSpaceAddExisting').onclick=()=>addExisting(p);
    if (activeTab === 'overview') await renderOverview(p);
    if (activeTab === 'chat' || activeTab === 'work') renderConversations(p, activeTab);
    if (activeTab === 'files') await renderFiles(p);
    if (activeTab === 'memory') {
      room.showProjectMemory(p.id); $('rcProjectBody').append($('crMemory')); $('crMemory').hidden = false;
      $('memoryProject').disabled=true;
      $('crMemory').querySelector('.workspace-actions').insertAdjacentHTML('afterbegin','<button class="cr-secondary" id="rcProjectBrief">Review project brief</button>');
      $('rcProjectBrief').onclick=()=>editBrief(p);
      document.body.classList.add('rc-spaces-view'); $('rcProjectPage').hidden = false;
      $('crMemoryTab').removeAttribute('aria-current'); $('crSpacesTab').setAttribute('aria-current', 'page');
      $('crBreadcrumb').innerHTML=link('/projects','Projects')+'<span class="crumb-sep">/</span><span>'+esc(p.name)+'</span>';
    }
    if (activeTab === 'settings') renderSettings(p);
  }
  const scopeOf = (p, sid) => p?.conversations?.find(c => c.sessionId === (sid || p.lastSessionId))?.spaceId;
  const scopeName = id => projects.find(s=>s.id===id)?.name || 'Standalone';
  const memberRows = p => (p.members || []).map(m => ({ p: engine.state().projects.find(x=>x.id===m.projectId), c: m.conversation, member: m })).filter(r=>r.p);
  function overviewRows(p) {
    const keys=new Set((p.members||[]).map(m=>JSON.stringify([m.projectId,m.sessionId||m.conversation?.sessionId])));
    return room.workspaceRows().filter(x=>keys.has(JSON.stringify([x.p.id,x.c.sessionId]))).sort((a,b)=>b.time-a.time);
  }
  function overviewConversation(x){
    const status={running:'Running',background:'Background',question:'Needs input',failed:'Failed',parked:'Paused',finished:'Ready to continue',idle:'Ready to continue'}[x.status]||'Ready to continue';
    return link(conversationPath(x.p,x.c.sessionId),`${icon(x.p.kind==='chat'?'chat':'terminal')}<span><strong>${esc(x.c.title)}</strong><small>${x.p.kind==='chat'?'Chat':'Work · '+esc(x.p.name)}</small></span><small>${status}</small>`,'workspace-overview-row');
  }
  async function renderOverview(p){
    const host=$('rcProjectBody'),serial=generation,rows=overviewRows(p),resume=rows[0];
    host.innerHTML=`<div class="workspace-overview"><div><section class="workspace-resume"><div class="cr-eyebrow">PICK UP WHERE YOU LEFT OFF</div>${resume?`<span class="workspace-kind">${icon(resume.p.kind==='chat'?'chat':'terminal')}${resume.p.kind==='chat'?'Chat':'Work'}</span><h2>${esc(resume.c.title)}</h2><p>Continue with the same conversation, saved files, and Project context.</p><div id="rcOverviewRecentFile"></div><footer>${link(conversationPath(resume.p,resume.c.sessionId),'Continue '+(resume.p.kind==='chat'?'Chat':'Work')+' '+icon('right'),'cr-primary')}<small>${resume.time?'Last activity '+esc(new Date(resume.time).toLocaleDateString()):'Ready when you are'}</small></footer>`:`<h2>What are we working on?</h2><p>Start a Chat, or link an existing conversation and its history.</p><button class="cr-primary" data-overview-new="chat" ${p.archivedAt?'disabled':''}>${icon('plus')} New Chat</button>`}</section><div class="workspace-section-heading"><h2>Recent conversations</h2><div class="rc-space-toolbar" style="margin:0"><button class="cr-secondary" data-overview-new="chat" ${p.archivedAt?'disabled':''}>New Chat</button><button class="cr-secondary" data-overview-new="work" ${p.archivedAt||!p.workspaceConfigured?'disabled':''}>New Work</button></div></div><div class="workspace-overview-rows">${rows.slice(0,6).map(overviewConversation).join('')||'<p class="rc-space-note">Your conversations will appear here.</p>'}</div><div class="workspace-section-heading"><h2>Needs your attention</h2>${link(path(p.id,'memory'),'Open Memory')}</div><div id="rcOverviewAttention">${rows.filter(r=>['question','failed','parked'].includes(r.status)).map(overviewConversation).join('')}<p id="rcOverviewMemoryReview" class="rc-space-note" role="status">Checking memory proposals…</p></div></div><aside class="workspace-overview-aside"><section><h2>Project brief</h2><p id="rcOverviewBrief" role="status">Loading approved brief…</p><button class="cr-secondary" id="rcOverviewEditBrief">Review brief</button></section><section id="rcOverviewCost" class="workspace-cost" aria-label="Project cost estimate"><h2>Total Project cost estimate</h2><strong>—</strong><small role="status">Loading recorded usage…</small></section><section><h2>Work repositories</h2>${(p.workProjects||[]).map(w=>link('/work/'+encodeURIComponent(w.id),`${icon('terminal')}<span><strong>${esc(w.name)}</strong><small>${w.wholeProject?'Whole repository':'Selected conversations'}</small></span>`,'workspace-overview-row')).join('')||'<p>No Work repository linked yet.</p>'}<button class="cr-secondary" id="rcOverviewAddWork" ${p.archivedAt?'disabled':''}>Link a repository</button></section><section><h2>Project Files</h2><p id="rcOverviewFileCount" role="status">Loading saved files…</p>${link(path(p.id,'files'),'Browse files '+icon('right'),'cr-secondary')}</section></aside></div>`;
    host.querySelectorAll('[data-overview-new]').forEach(b=>b.onclick=()=>newConversation(p,b.dataset.overviewNew));
    $('rcOverviewEditBrief').onclick=()=>editBrief(p);$('rcOverviewAddWork').onclick=()=>addWorkProject(p);
    const current=()=>generation===serial&&host.isConnected&&activeTab==='overview'&&activeId===p.id;
    const tasks=await Promise.allSettled([
      request('/api/memory/search?'+new URLSearchParams({spaceId:p.id,scope:'space',tag:'project-brief',status:'confirmed',access:'library',limit:100})),
      request('/api/memory/search?'+new URLSearchParams({spaceId:p.id,status:'proposed',access:'library',limit:1})),
      request(base(p.id)+'/files'),
      updateOverviewCost(p.id)
    ]);
    if(!current())return;
    const [brief,review,files]=tasks;
    $('rcOverviewBrief').textContent=brief.status==='fulfilled'?(brief.value.items.find(e=>(e.spaceId||e.projectId)===p.id&&e.status==='confirmed')?.content||'Add an approved brief so every conversation can start from the same Project context.'):'Could not load the brief. Open Memory to retry.';
    const reviewNode=$('rcOverviewMemoryReview');
    if(review.status==='fulfilled'){const n=review.value.total??review.value.items.length;reviewNode.innerHTML=n?link(path(p.id,'memory'),`${n} memory proposal${n===1?'':'s'} ready for review`):'No memory proposals awaiting review.';}else reviewNode.textContent='Memory review count unavailable. Open Memory to retry.';
    if(files.status==='fulfilled'){
      const saved=files.value.files.filter(f=>!f.removed);$('rcOverviewFileCount').textContent=saved.length+' shared file'+(saved.length===1?'':'s')+' · versions retained';
      const newest=saved.sort((a,b)=>(b.versions.at(-1)?.createdAt||0)-(a.versions.at(-1)?.createdAt||0))[0];
      if(newest&&$('rcOverviewRecentFile')){$('rcOverviewRecentFile').innerHTML=`<button class="workspace-overview-row workspace-resume-file">${icon('file')}<span><strong>${esc(newest.name)}</strong><small>${newest.versions.length} saved version${newest.versions.length===1?'':'s'} · Project Files</small></span>${icon('right')}</button>`;$('rcOverviewRecentFile').querySelector('button').onclick=()=>versionsDialog(p,newest);}
    }else $('rcOverviewFileCount').textContent='Could not load Files. Open Files to retry.';
  }
  async function updateOverviewCost(id,force=false){
    const host=$('rcOverviewCost');if(!host)return;
    const data=await room.projectCost(id,force);if(!host.isConnected||activeId!==id||activeTab!=='overview')return;
    const row=data.row,money=n=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n),tokenCount=row?Object.values(row.usage.byModel||{}).map(m=>m.input+m.output+m.cacheRead+m.cacheWrite):[],max=Math.max(1,...tokenCount);
    host.innerHTML='<h2>Total Project cost estimate</h2>'+(!data.ready||data.error?`<strong>—</strong><small role="status">${esc(data.error||'Cost estimate unavailable')}</small><button class="cr-secondary" data-cost-retry>Retry</button>`:`<strong>≈ ${money(row?.cost.usd||0)}</strong><small>Recorded lifetime usage · includes subagents</small><p>${row?.partial?'Scanning transcripts; total is still updating.':row?.missing?'Some conversations have missing transcripts.':row?.cost.unpriced.length?'Some models are unpriced.':'Standard API rates, not your subscription bill.'}</p>${row?`<div class="workspace-cost-bars" aria-label="Recorded tokens by model">${Object.entries(row.usage.byModel||{}).sort((a,b)=>(b[1].input+b[1].output+b[1].cacheRead+b[1].cacheWrite)-(a[1].input+a[1].output+a[1].cacheRead+a[1].cacheWrite)).slice(0,4).map(([name,m])=>{const total=m.input+m.output+m.cacheRead+m.cacheWrite;return `<div><span><span>${esc(name)}</span><span>${new Intl.NumberFormat(undefined,{notation:'compact'}).format(total)}</span></span><i><b style="width:${total/max*100}%"></b></i></div>`;}).join('')}</div>`:''}<small class="workspace-cost-caption">Current primary membership. References excluded.</small><button class="cr-secondary" data-cost-details>View breakdown</button>`);
    host.querySelector('[data-cost-retry]')?.addEventListener('click',()=>updateOverviewCost(id,true));host.querySelector('[data-cost-details]')?.addEventListener('click',()=>room.showCosts());
  }
  function renderConversations(p, mode) {
    $('rcProjectBody').innerHTML = `<div class="rc-space-toolbar"><label class="cr-search">${icon('search')}<input id="rcSpaceConversationSearch" type="search" placeholder="Search ${mode}" aria-label="Search ${mode}"></label>${mode==='work'?'<button class="cr-secondary" id="rcSpaceAddWork">Add Work project</button>':''}<button class="cr-primary" id="rcSpaceNewConversation" ${p.archivedAt || (mode==='work'&&!p.workspaceConfigured)?'disabled':''}>New ${mode}</button></div>${mode==='work'&&!p.workspaceConfigured?'<div class="cr-empty"><h2>Add a Work project</h2><p>Choose an existing repository or configure a Work workspace.</p></div>':''}<div class="rc-space-conversations" id="rcSpaceConversations"></div><div id="rcSpaceReferences"></div>`;
    const row = (execution,c,included=true) => `<div class="rc-space-member ${included?'':'rc-space-exception'}">${link(conversationPath(execution,c.sessionId),`${icon(mode==='chat'?'chat':'menu')}<span><strong>${esc(c.title)}</strong><small>${esc(c.provider||execution.provider||'claude')}${execution.runningSessionIds.includes(c.sessionId)?' · Running':execution.backgroundSessionIds.includes(c.sessionId)?' · Background':''}${!included?' · Uses Project '+esc(scopeName(c.spaceId)):''}</small></span>${icon('right')}`,'rc-space-conversation')}<button class="cr-icon" data-membership-project="${esc(execution.id)}" data-membership-session="${esc(c.sessionId)}" aria-label="Change Project for ${esc(c.title)}">${icon('gear')}</button></div>`;
    const render = () => {
      const q=$('rcSpaceConversationSearch').value.toLowerCase();
      $('rcSpaceConversations').innerHTML = mode==='chat' ? memberRows(p).filter(r=>r.p.kind==='chat'&&r.c.title.toLowerCase().includes(q)).map(r=>row(r.p,r.c)).join('') : (p.workProjects||[]).map(work=>{
        const rows=work.conversations.filter(c=>(work.wholeProject||c.included)&&(work.name+' '+c.title).toLowerCase().includes(q));
        if(!rows.length&&q&&!work.name.toLowerCase().includes(q))return '';
        return `<section class="rc-space-work-group" data-work-project="${esc(work.id)}"><header><div>${link('/work/'+encodeURIComponent(work.id),esc(work.name))}<small>${work.wholeProject?'Whole Work project · includes future conversations':'Selected conversations'} · ${esc(work.cwd||'Workspace unavailable')}</small></div><button class="cr-secondary" data-whole-work="${esc(work.id)}">Manage association</button></header>${rows.map(c=>row(work,c,c.included)).join('')||'<p class="rc-space-note">No conversations yet.</p>'}</section>`;
      }).join('');
      if(!$('rcSpaceConversations').innerHTML)$('rcSpaceConversations').innerHTML='<p class="cr-empty">No conversations found.</p>';
      $('rcSpaceConversations').querySelectorAll('[data-membership-project]').forEach(b=>b.onclick=()=>membershipDialog(engine.state().projects.find(x=>x.id===b.dataset.membershipProject),undefined,b.dataset.membershipSession));
      $('rcSpaceConversations').querySelectorAll('[data-whole-work]').forEach(b=>b.onclick=()=>reviewMembership({kind:'work-project',projectId:b.dataset.wholeWork},p.id));
    };
    $('rcSpaceConversationSearch').oninput=render; $('rcSpaceNewConversation').onclick=()=>newConversation(p,mode);
    if($('rcSpaceAddWork'))$('rcSpaceAddWork').onclick=()=>addWorkProject(p);
    render(); renderReferences(p);
  }
  function renderReferences(p) {
    const all=engine.state().projects, host=$('rcSpaceReferences');
    host.innerHTML=`<h2 class="rc-space-section-title">References</h2><p class="rc-space-note">Links keep their own primary Project. They do not inherit this Project’s memory or file access.</p>`+(p.references||[]).map(r=>{
      const target=all.find(x=>x.id===r.target.projectId), c=target?.conversations?.find(c=>c.sessionId===r.target.sessionId);
      const url=target?(r.target.kind==='work-project'?'/work/'+encodeURIComponent(target.id):conversationPath(target,c?.sessionId||target.lastSessionId)):null;
      return `<div class="rc-space-member">${url?link(url,icon(r.target.kind==='chat'?'chat':'folder')+'<span><strong>'+esc(c?.title||target.name)+'</strong><small>Reference</small></span>','rc-space-conversation'):'<span>Reference unavailable</span>'}<button class="cr-icon" data-remove-reference="${esc(r.id)}" aria-label="Remove reference">${icon('x')}</button></div>`;
    }).join('');
    host.querySelectorAll('[data-remove-reference]').forEach(b=>b.onclick=action(async()=>{await request(base(p.id)+'/references/remove',{referenceId:b.dataset.removeReference,expectedRevision:registryRevision});await route();}));
  }
  function controls(form, defaults = {}) {
    const f = form.elements;
    f.provider.value = defaults.provider || 'codex';
    const efforts = () => { const m = engine.defaultModelOptions(f.provider.value).find(m => m.value === f.model.value); f.effort.innerHTML = (m?.efforts || [{ value: '', label: 'Provider default' }]).map(e => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join(''); };
    const choices = () => {
      f.model.innerHTML = '<option value="">Provider default</option>' + engine.defaultModelOptions(f.provider.value).map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');
      f.account.innerHTML = '<option value="">Automatic</option>' + engine.state().accounts.filter(a => a.provider === f.provider.value).map(a => `<option value="${esc(a.name)}">${esc(a.label || a.name)}</option>`).join(''); efforts();
    };
    f.provider.onchange = choices; f.model.onchange = efforts; choices();
    f.model.value = defaults.model || ''; efforts(); f.effort.value = defaults.effort || ''; f.account.value = defaults.account || '';
  }
  const controlsMarkup = '<div class="rc-chat-form-grid"><label>Provider<select name="provider"><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>Account<select name="account"></select></label><label>Model<select name="model"></select></label><label>Effort<select name="effort"></select></label></div>';
  function workChoices(selected, candidates=engine.state().projects.filter(p=>p.kind!=='chat'&&!p.archivedAt&&p.cwd)) {
    return `<label>Work project<select name="workProjectId" required><option value="">Choose a repository</option>${candidates.map(w=>`<option value="${esc(w.id)}" ${w.id===selected?'selected':''}>${esc(w.name)} · ${esc(w.cwd)}</option>`).join('')}</select></label>`;
  }
  function newConversation(p, mode, workId) {
    const candidates=p?.workProjects?.filter(w=>!w.archivedAt&&w.cwd)||[], chosen=workId||p?.defaultWorkProjectId||(candidates.length===1?candidates[0].id:'');
    const d=dialog('New '+mode,`<form class="workspace-form"><label>Name<input name="name" placeholder="New ${mode}" maxlength="300"></label>${mode==='work'?workChoices(chosen):''}${controlsMarkup}<p role="alert"></p><button class="cr-primary">Create ${mode}</button></form>`),form=d.querySelector('form'),requestId=crypto.randomUUID();
    const setDefaults=()=>{const w=engine.state().projects.find(x=>x.id===form.elements.workProjectId?.value);controls(form,{provider:w?.provider||'claude',...w?.defaults?.work,...p?.defaults?.[mode]});}; setDefaults();
    if(form.elements.workProjectId)form.elements.workProjectId.onchange=setDefaults;
    form.onsubmit=async event=>{event.preventDefault();const f=form.elements;form.querySelector('button').disabled=true;
      try{const input={requestId,name:f.name.value||undefined,provider:f.provider.value,model:f.model.value,effort:f.effort.value,account:f.account.value};
        const result=await request(mode==='chat'?'/api/chats':p?base(p.id)+'/work':'/api/project-spaces/executions/'+encodeURIComponent(f.workProjectId.value)+'/work',mode==='chat'?{...input,spaceId:p?.id}:{...input,...(p?{workProjectId:f.workProjectId.value}:{})});
        await engine.reloadProjects();await load();d.close();await navigate(mode==='chat'?'/chat/'+result.id:'/work/'+encodeURIComponent(result.projectId)+'/'+encodeURIComponent(result.sessionId));
      }catch(error){form.querySelector('[role=alert]').textContent=error.message;}finally{form.querySelector('button').disabled=false;}
    };
  }
  function addWorkProject(p) {
    const d=dialog('Add Work project',`<form class="workspace-form">${workChoices('')}<p>Select an existing repository, or configure a new Work project below.</p><button type="button" class="cr-secondary" data-existing>Review association</button><hr><label>New Work project name<input name="name" maxlength="300"></label><label>Workspace directory<input name="cwd" placeholder="Full directory under the workspace root"></label><p>The repository and provider sessions stay in this directory.</p><p role="alert"></p><button class="cr-primary">Create Work project and review</button></form>`),form=d.querySelector('form');
    form.querySelector('[data-existing]').onclick=()=>{const id=form.elements.workProjectId.value;if(id){d.close();reviewMembership({kind:'work-project',projectId:id},p.id);}};
    form.noValidate=true;
    form.onsubmit=async e=>{e.preventDefault();const f=form.elements;if(!f.name.value.trim()||!f.cwd.value.trim()){form.querySelector('[role=alert]').textContent='Enter a name and workspace directory.';return;}form.querySelector('.cr-primary').disabled=true;
      try{const work=await request('/api/projects',{name:f.name.value,cwd:f.cwd.value});await engine.reloadProjects();d.close();await reviewMembership({kind:'work-project',projectId:work.id},p.id);}catch(error){form.querySelector('[role=alert]').textContent=error.message;}finally{form.querySelector('.cr-primary').disabled=false;}
    };
  }
  async function renderFiles(p) {
    const body = $('rcProjectBody'), data = await request(base(p.id) + '/files');
    if (activeId !== p.id || activeTab !== 'files') return;
    body.innerHTML = `<div class="rc-space-toolbar"><h2>Project files</h2><button class="cr-primary" id="rcSpaceUpload" ${p.archivedAt ? 'disabled' : ''}>Upload files</button><input id="rcSpaceUploadInput" type="file" multiple hidden></div><p class="rc-space-note">Saved versions stay available across Chat, Work, and account changes.</p><div id="rcSpaceUploadStatus" role="status"></div><div class="rc-space-files">${data.files.map(file => `<article data-project-file="${esc(file.id)}" class="rc-space-file ${file.removed ? 'removed' : ''}">${icon('file')}<div><strong>${esc(file.name)}</strong><small>${file.versions.length} saved version${file.versions.length === 1 ? '' : 's'}${file.sourceFileId ? ' · Shared from Chat' : file.sourceArtifactId ? ' · Work output' : ' · Project upload'}${file.removed ? ' · Removed' : ''}${file.memorySources?.length?' · Used by '+file.memorySources.length+' memory sources; retained after removal':''}</small></div><button data-versions class="cr-secondary">Versions</button><button data-memory-file class="cr-secondary">Add to memory</button><button data-attach class="cr-secondary" ${file.removed || p.archivedAt ? 'disabled' : ''}>Use in conversation</button><button data-remove class="cr-icon" aria-label="${file.removed ? 'Restore' : 'Remove'} ${esc(file.name)}">${icon(file.removed ? 'history' : 'x')}</button></article>`).join('') || '<p class="cr-empty">Upload a document or add a saved Chat or Work output.</p>'}</div>`;
    $('rcSpaceUpload').onclick = () => $('rcSpaceUploadInput').click();
    $('rcSpaceUploadInput').onchange = () => upload(p, [...$('rcSpaceUploadInput').files]);
    body.querySelectorAll('[data-project-file]').forEach(row => {
      const file = data.files.find(f => f.id === row.dataset.projectFile);
      row.querySelector('[data-memory-file]').onclick=()=>room.addFileToMemory(p.id,file,file.latestVersionId);
      row.querySelector('[data-versions]').onclick = () => versionsDialog(p, file);
      row.querySelector('[data-attach]').onclick = () => attachDialog(p, file, file.latestVersionId);
      row.querySelector('[data-remove]').onclick = action(async () => { await request(base(p.id) + '/files/' + file.id, { removed: !file.removed }); await renderFiles(p); });
      if(window.rcWorkspace){
        const actions=[...row.querySelectorAll('button')];
        const group=document.createElement('div');group.className='workspace-file-actions';actions.forEach(b=>group.append(b));row.append(group);
        const more=document.createElement('button');more.className='cr-icon rc-space-file-menu';more.setAttribute('aria-label','Actions for '+file.name);more.setAttribute('aria-haspopup','menu');more.innerHTML=icon('more');row.append(more);
        more.onclick=()=>showFileMenu(more,actions);
        row.querySelector('strong').parentElement.insertAdjacentHTML('beforeend',`<small>${Math.ceil((file.versions.find(v=>v.id===file.latestVersionId)?.bytes||0)/1024)} KiB${file.memorySources?.length?' · Memory source':''}</small>`);
        row.querySelector('strong').tabIndex=0;row.querySelector('strong').setAttribute('role','button');row.querySelector('strong').onclick=()=>versionsDialog(p,file);row.querySelector('strong').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();versionsDialog(p,file);}};
      }
    });
    renderUploads();
  }
  function renderUploads() {
    const node = $('rcSpaceUploadStatus'); if (!node) return;
    node.innerHTML = [...uploads.values()].filter(j => j.ownerId === activeId).map(j => `<div class="rc-space-upload"><span>${esc(j.names)} · ${esc(j.state)}${j.progress === undefined ? '' : ' ' + j.progress + '%'}</span>${j.state === 'uploading' ? `<button data-cancel="${j.id}">Cancel</button>` : j.state !== 'saved' ? `<button data-retry="${j.id}">Retry</button>` : ''}</div>`).join('');
    node.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => uploads.get(b.dataset.cancel)?.xhr.abort());
    node.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => runUpload(uploads.get(b.dataset.retry)));
  }
  function showFileMenu(anchor,actions){
    let menu=$('workspaceFileMenu');if(!menu){menu=document.createElement('div');menu.id='workspaceFileMenu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');document.body.append(menu);}
    if(menu.matches(':popover-open'))menu.hidePopover();
    menu.replaceChildren();actions.forEach(original=>{const b=document.createElement('button');b.textContent=original.getAttribute('aria-label')||original.textContent;b.setAttribute('role','menuitem');b.disabled=original.disabled;b.onclick=()=>{menu.hidePopover();original.click();};menu.append(b);});
    menu.showPopover();const r=anchor.getBoundingClientRect(),size=menu.getBoundingClientRect();menu.style.left=Math.max(10,Math.min(r.right-size.width,innerWidth-size.width-10))+'px';menu.style.top=(r.bottom+size.height+8<innerHeight?r.bottom+6:Math.max(10,r.top-size.height-6))+'px';
    menu.querySelector('button:not(:disabled)')?.focus();
    menu.onkeydown=e=>{const items=[...menu.querySelectorAll('button:not(:disabled)')],i=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();menu.hidePopover();anchor.focus();}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(i+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}};
  }
  function upload(p, files) {
    if (!files.length) return;
    if (files.length > 20 || files.some(f => f.size > 50 * 1024 * 1024) || files.reduce((n, f) => n + f.size, 0) > 200 * 1024 * 1024) return room.notify('Use up to 20 files, 50 MiB each and 200 MiB total.');
    const job = { id: crypto.randomUUID(), ownerId: p.id, files, names: files.map(f => f.name).join(', '), state: 'uploading' }; uploads.set(job.id, job); runUpload(job);
  }
  function runUpload(job) {
    const xhr = new XMLHttpRequest(); job.xhr = xhr; job.state = 'uploading'; job.progress = 0;
    xhr.open('POST', base(job.ownerId) + '/files'); xhr.setRequestHeader('x-upload-id', job.id);
    const token = localStorage.getItem('x056_token'); if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = e => { if (e.lengthComputable) job.progress = Math.round(e.loaded * 100 / e.total); renderUploads(); };
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) { job.state = 'saved'; job.files = []; }
      else { try { job.state = JSON.parse(xhr.responseText).message || 'Upload failed'; } catch { job.state = 'Upload failed'; } }
      if (activeId === job.ownerId && activeTab === 'files') await renderFiles(projects.find(p => p.id === job.ownerId));
    };
    xhr.onerror = () => { job.state = 'Upload interrupted'; renderUploads(); }; xhr.onabort = () => { job.state = 'Cancelled'; renderUploads(); };
    const form = new FormData(); job.files.forEach(f => form.append('files', f)); xhr.send(form); renderUploads();
  }
  function fileSourceLink(file,version) {
    const source=engine.state().projects.find(p=>p.id===(version.sourceProjectId||file.sourceOwnerId));
    const sid=version.sourceSessionId||(source?.kind==='chat'?source.lastSessionId:null);
    if(source&&sid)return link(conversationPath(source,sid),'Source '+(source.kind==='chat'?'Chat':'Work'),'cr-secondary');
    return (version.sourceProjectId||file.sourceOwnerId)?'<small>Source conversation unavailable</small>':'';
  }
  function versionsDialog(p, file) {
    const d = dialog(file.name, `<div class="rc-space-version-list">${[...file.versions].reverse().map((v, i) => `<article data-version="${esc(v.id)}"><strong>${i === 0 ? 'Latest version' : 'Earlier version'}</strong><small>${esc(new Date(v.createdAt).toLocaleString())} · ${Math.ceil(v.bytes / 1024)} KiB</small><div>${fileSourceLink(file,v)}<button data-download class="cr-secondary">Download</button><button data-memory-version class="cr-secondary">Add to memory</button><button data-preview class="cr-secondary">Preview</button><button data-attach class="cr-secondary">Attach</button><button data-restore class="cr-secondary" ${p.archivedAt ? 'disabled' : ''}>Restore as new version</button></div></article>`).join('')}</div><div id="rcSpacePreview" role="status"></div>`);
    const urls = []; d.addEventListener('close', () => urls.forEach(URL.revokeObjectURL));
    const fetchBlob = async url => { const response = await engine.api(url); if (!response.ok) throw new Error('File unavailable'); const blob = await response.blob(), object = URL.createObjectURL(blob); urls.push(object); return { blob, object }; };
    d.querySelectorAll('[data-version]').forEach(row => {
      const v = file.versions.find(v => v.id === row.dataset.version), root = base(p.id) + '/files/' + file.id + '/versions/' + v.id;
      row.querySelector('[data-memory-version]').onclick=()=>room.addFileToMemory(p.id,file,v.id);
      row.querySelector('[data-download]').onclick = action(async () => { const { object } = await fetchBlob(root + '/download'); const a = document.createElement('a'); a.href = object; a.download = file.name; a.click(); });
      row.querySelector('[data-attach]').onclick = () => { d.close(); attachDialog(p, file, v.id); };
      row.querySelector('[data-restore]').onclick = action(async () => { await request(base(p.id) + '/files/' + file.id + '/restore', { operationId: crypto.randomUUID(), versionId: v.id, expectedBaseVersionId: file.latestVersionId }); d.close(); await renderFiles(p); });
      row.querySelector('[data-preview]').onclick = action(async () => {
        const host = d.querySelector('#rcSpacePreview'); host.textContent = 'Preparing preview…';
        if (v.mime.startsWith('image/') && !v.mime.includes('svg')) { const { object } = await fetchBlob(root + '/content'); host.innerHTML = `<img src="${object}" alt="${esc(file.name)}">`; return; }
        if (v.mime.startsWith('text/') || v.mime === 'application/json') { const response = await engine.api(root + '/content'); if (!response.ok) throw new Error('Preview unavailable'); const pre = document.createElement('pre'); pre.textContent = (await response.text()).slice(0, 200000); host.replaceChildren(pre); return; }
        let job = await request(root + '/preview');
        while (d.open && ['queued', 'running'].includes(job.state)) { await new Promise(r => setTimeout(r, 800)); if (!d.open) return; job = await request(root + '/preview'); }
        if (!d.open) return;
        if (job.state !== 'ready') { host.textContent = (job.error || 'Preview is unavailable for this format.') + ' Download the saved file to continue.'; const retry = document.createElement('button'); retry.textContent = 'Retry preview'; retry.onclick = action(async () => { await request(root + '/preview', {}); row.querySelector('[data-preview]').click(); }); host.append(retry); return; }
        const count=JSON.parse(job.output).length-1;let page=1;
        host.innerHTML='<div class="rc-space-toolbar"><button data-prev>Previous</button><span></span><button data-next>Next</button></div><div data-page></div>';
        const render=async()=>{host.querySelector('span').textContent=`Page ${page} of ${count}${count===30?' (preview limit)':''}`;host.querySelector('[data-prev]').disabled=page===1;host.querySelector('[data-next]').disabled=page===count;const {object}=await fetchBlob(root+'/preview/'+page);if(d.open)host.querySelector('[data-page]').innerHTML=`<img src="${object}" alt="Page ${page} of ${esc(file.name)}">`;};
        host.querySelector('[data-prev]').onclick=action(async()=>{page--;await render();});host.querySelector('[data-next]').onclick=action(async()=>{page++;await render();});await render();
      });
    });
  }
  function attachDialog(p, file, versionId) {
    const rows = memberRows(p);
    const d = dialog('Use file in a conversation', `<div class="rc-space-version-list">${rows.map(({ p: execution, c }) => `<button class="rc-space-conversation" data-execution="${esc(execution.id)}" data-session="${esc(c.sessionId)}">${icon(execution.kind === 'chat' ? 'chat' : 'menu')}<span><strong>${esc(c.title)}</strong><small>${execution.kind === 'chat' ? 'Chat' : 'Work'}</small></span></button>`).join('') || '<p>Create a Chat or Work conversation first.</p>'}</div>`);
    d.querySelectorAll('[data-execution]').forEach(b => b.onclick = action(async () => {
      engine.attachSaved(b.dataset.execution, b.dataset.session, { fileId: file.id, versionId, ownerId: p.id, name: file.name });
      const execution = engine.state().projects.find(x => x.id === b.dataset.execution); d.close(); await navigate(conversationPath(execution, b.dataset.session));
    }));
  }
  function renderSettings(p) {
    $('rcProjectBody').innerHTML = `<form class="workspace-form rc-space-settings" id="rcSpaceSettings"><label>Project name<input name="name" value="${esc(p.name)}" required maxlength="300"></label>${workChoices(p.defaultWorkProjectId)}<p class="rc-space-note">Default repository for new Work. Each conversation retains its original directory.</p><fieldset><legend>Defaults for new conversations</legend><label>Mode<select name="mode"><option value="chat">Chat</option><option value="work">Work</option></select></label>${controlsMarkup}</fieldset><label>Required tools<textarea name="tools" rows="3" placeholder="One key per line, such as skill:rc-documents">${esc((p.requiredTools || []).map(r => r.key).join('\n'))}</textarea></label><p class="rc-space-note">Each account must verify required plugins, MCP servers, and skills in the conversation’s own directory.</p><p role="alert"></p><div class="rc-space-toolbar"><button class="cr-primary">Save settings</button><button type="button" class="cr-secondary" id="rcSpaceMemorySettings">Workspace memory settings</button><button type="button" class="cr-secondary" id="rcSpaceArchive">${p.archivedAt ? 'Restore project' : 'Archive project'}</button></div></form>`;
    const form = $('rcSpaceSettings'), f = form.elements, defaults = structuredClone(p.defaults || {}); let mode = 'chat'; f.workProjectId.required=false; controls(form, defaults.chat);
    const saveMode = () => { defaults[mode] = { provider: f.provider.value, model: f.model.value, effort: f.effort.value, account: f.account.value || undefined }; };
    f.mode.onchange = () => { saveMode(); mode = f.mode.value; controls(form, defaults[mode]); };
    form.onsubmit = async e => { e.preventDefault(); saveMode(); form.querySelector('button').disabled = true;
      try { await request(base(p.id), { expectedRevision: p.revision || 0, name: f.name.value, defaultWorkProjectId: f.workProjectId.value, defaults, requiredTools: f.tools.value.split('\n').map(s => s.trim()).filter(Boolean).map(key => ({ key })) }); await engine.reloadProjects(); await route(); }
      catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { form.querySelector('button').disabled = false; }
    };
    $('rcSpaceMemorySettings').onclick=()=>room.memorySettings();
    $('rcSpaceArchive').onclick = action(async () => {
      if (!await engine.confirm({ title: p.archivedAt ? 'Restore project?' : 'Archive project?', message: `${p.chats.length} Chat, ${(p.members||[]).filter(m=>m.mode==='work').length} Work and ${p.activity.queued} queued messages. History and files stay available. Scheduled jobs and autopilots pause; restoring does not resume them.` })) return;
      await request(base(p.id) + '/archive', { expectedRevision: p.revision || 0, expectedTopology: topology, operationId: crypto.randomUUID(), archived: !p.archivedAt }); await engine.reloadProjects(); await route();
    });
  }
  async function membershipDialog(execution, parentId, sid) {
    if (!execution) return addExisting(projects.find(p=>p.id===parentId));
    await load(); await engine.reloadProjects();
    return reviewMembership(execution.kind==='chat'?{kind:'chat',projectId:execution.id}:{kind:'work-conversation',projectId:execution.id,sessionId:sid||engine.state().sessionId},parentId||scopeOf(execution,sid));
  }
  async function addExisting(space) {
    await engine.reloadProjects(); await load();
    const d=dialog('Add existing',`<form class="workspace-form"><div class="rc-space-picker-tabs" role="group" aria-label="Choose what to add">${[['chat','Chat'],['work-conversation','Work conversations'],['work-project','Work projects']].map(([value,label],i)=>`<label><input type="radio" name="kind" value="${value}" ${i===0?'checked':''}>${label}</label>`).join('')}</div><label>Search<input type="search" name="search" placeholder="Projects and conversations"></label><div class="rc-space-picker-results"></div></form>`), form=d.querySelector('form');
    const render=()=>{const kind=form.elements.kind.value,q=form.elements.search.value.trim().toLowerCase(),all=engine.state().projects.filter(p=>!p.archivedAt),targets=[];
      form.querySelector('.rc-space-picker-results').innerHTML=all.filter(p=>(kind==='chat')===(p.kind==='chat')).map(p=>{
        const rows=kind==='work-project'?[{title:p.name,spaceId:p.workSpaceId}]:p.conversations||[];
        const markup=rows.filter(c=>(p.name+' '+c.title).toLowerCase().includes(q)).map(c=>{const target={kind,projectId:p.id,...(kind==='work-conversation'?{sessionId:c.sessionId}:{})},index=targets.push(target)-1;
          return `<button type="button" class="rc-space-conversation" data-pick="${index}">${icon(kind==='chat'?'chat':'folder')}<span><strong>${esc(c.title)}</strong><small>${esc(scopeName(c.spaceId))}${c.inherited?' · Inherited':''}${p.runningSessionIds.includes(c.sessionId)?' · Running':''}${p.backgroundSessionIds.includes(c.sessionId)?' · Background':''}</small></span>${icon('plus')}</button>`;
        }).join(''); return markup?`<section><h3>${esc(p.name)}</h3>${markup}</section>`:'';
      }).join('')||'<p class="cr-empty">No matches.</p>';
      form.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{d.close();reviewMembership(targets[Number(b.dataset.pick)],space.id);});
    }; form.oninput=render;form.onsubmit=e=>e.preventDefault();render();
  }
  async function reviewMembership(target, destination) {
    await load();await engine.reloadProjects();
    const execution=engine.state().projects.find(p=>p.id===target.projectId),conversation=execution?.conversations?.find(c=>c.sessionId===target.sessionId),current=target.kind==='work-project'?execution?.workSpaceId:scopeOf(execution,target.sessionId);
    const d=dialog('Review Project association',`<form class="workspace-form"><p><strong>${esc(conversation?.title||execution?.name)}</strong> · ${esc(target.kind==='work-project'?'Whole Work project':target.kind==='chat'?'Chat':'Work conversation')}</p><p>Current Project: ${esc(scopeName(current))}. ${target.kind==='work-project'?'Current and future inherited conversations will follow this association.':''}</p><label>Destination<select name="destination"><option value="">Standalone</option>${target.kind==='work-conversation'?'<option value="inherit">Use Work project’s Project</option>':''}${projects.filter(p=>!p.archivedAt).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><label>Action<select name="action"><option value="primary">${current?'Move primary association':'Set primary association'}</option><option value="reference">Add as reference only</option></select></label>${target.kind==='work-project'?'<label class="workspace-check"><input type="checkbox" name="includeOverrides">Also include conversations with explicit overrides</label>':''}<p>Earlier memory remains in provider history. A move retains messages and requires review before waiting work resumes.</p><div data-impact></div><p role="alert"></p><div class="rc-space-toolbar"><button type="button" class="cr-secondary" data-preview>Preview changes</button><button class="cr-primary" disabled>Apply reviewed change</button></div></form>`),form=d.querySelector('form'),operationId=crypto.randomUUID();
    form.elements.destination.value=destination||current||'';let reviewed,previewSerial=0;
    const invalidate=()=>{previewSerial++;reviewed=null;form.querySelector('.cr-primary').disabled=true;form.querySelector('[data-impact]').textContent='';};form.onchange=invalidate;
    form.querySelector('[data-preview]').onclick=async()=>{invalidate();const serial=previewSerial;form.querySelector('[role=alert]').textContent='';const f=form.elements;
      try{if(f.action.value==='reference'){if(!f.destination.value||f.destination.value==='inherit')throw new Error('Choose a Project for the reference');reviewed={reference:true,expectedRevision:registryRevision};form.querySelector('[data-impact]').textContent='Adds a link. Primary context, file access, and totals stay with the current Project.';}
        else{const change={target,assignment:f.destination.value==='inherit'?{mode:'inherit'}:f.destination.value?{mode:'space',spaceId:f.destination.value}:{mode:'standalone'},...(target.kind==='work-project'?{includeOverrides:f.includeOverrides.checked}:{})};const result=await request('/api/project-spaces/membership/preview',change);if(serial!==previewSerial||!d.open)return;reviewed=result;
          form.querySelector('[data-impact]').innerHTML=`<h3>${reviewed.affected.length} conversations affected</h3><div class="rc-space-impact">${reviewed.details.map(r=>{const p=engine.state().projects.find(p=>p.id===r.projectId),c=p?.conversations?.find(c=>c.sessionId===r.sessionId);return `<article><strong>${esc(c?.title||r.sessionId)}</strong><small>${esc(scopeName(r.beforeSpaceId))} → ${esc(scopeName(r.afterSpaceId))}</small><p>${r.queues.length} queued · ${r.approvals.length} approvals${r.autopilot?' · Autopilot pauses':''}${r.running||r.background?' · Finish active work first':''}</p></article>`;}).join('')}</div><p>${reviewed.exceptions.length} explicit overrides ${f.includeOverrides?.checked?'included':'retained'}. Matching schedules and pending sends need review. Shared-file access follows the destination Project.</p>`;
        }form.querySelector('.cr-primary').disabled=reviewed.details?.some(r=>r.running||r.background)||false;
      }catch(e){if(serial===previewSerial&&d.open)form.querySelector('[role=alert]').textContent=e.message;}
    };
    form.onsubmit=async e=>{e.preventDefault();if(!reviewed)return;form.querySelector('.cr-primary').disabled=true;
      try{if(reviewed.reference)await request(base(form.elements.destination.value)+'/references',{target,expectedRevision:reviewed.expectedRevision,requestId:operationId});else await request('/api/project-spaces/membership/apply',{target:reviewed.target,assignment:reviewed.assignment,...(reviewed.includeOverrides!==undefined?{includeOverrides:reviewed.includeOverrides}:{}),operationId,expectedRevision:reviewed.revision,expectedTopology:reviewed.topology,expectedImpactHash:reviewed.impactHash,expectedReviewHash:reviewed.reviewHash});
        await engine.reloadProjects();await load();d.close();if(handles(location.pathname))await route();else updateContext();room.refresh();
      }catch(error){form.querySelector('[role=alert]').textContent=error.message;invalidate();}
    };
  }
  async function reviewQueue(id, item, after) {
    await engine.reloadProjects();const p=engine.state().projects.find(p=>p.id===id),context=await request('/api/project-spaces/context/'+encodeURIComponent(id)+'/'+encodeURIComponent(item.sessionId)),parent=projects.find(x=>x.id===context.spaceId);
    const d=dialog('Review waiting message',`<form class="workspace-form"><p>${esc(item.contextReview.reason)}. Future turns use ${esc(parent?.name||'local conversation')} memory. Earlier context remains in provider history.</p><button type="button" class="cr-secondary" data-context>Inspect memory context</button><label>Message<textarea name="text" rows="6" required>${esc(item.text)}</textarea></label><fieldset><legend>Keep these saved versions</legend>${(item.fileRefs||[]).map((ref,i)=>`<label class="workspace-check"><input type="checkbox" data-ref="${i}" checked><span>${esc(ref.name||ref.fileId)} · ${esc(ref.versionId)}</span></label>`).join('')||'<p>No attached files.</p>'}</fieldset><p>Uncheck files from a previous Project to remove them. Remaining attachments are checked before dispatch.</p><p role="alert"></p><button class="cr-primary">Save review and resume</button></form>`);
    d.querySelector('[data-context]').onclick=()=>room.memoryContext({projectId:id,sessionId:item.sessionId,requestId:item.requestId});const form=d.querySelector('form');
    form.onsubmit=async e=>{e.preventDefault();form.querySelector('.cr-primary').disabled=true;try{const fileRefs=[...form.querySelectorAll('[data-ref]:checked')].map(x=>item.fileRefs[Number(x.dataset.ref)]);await request(base(id)+'/queue/'+item.id+'/review',{expectedMembershipRevision:context.membershipRevision,review:{expectedText:item.text,text:form.elements.text.value,fileRefs}});d.close();after();}catch(e){form.querySelector('[role=alert]').textContent=e.message;}finally{form.querySelector('.cr-primary').disabled=false;}};
  }
  async function resumeAutopilot(id,sid,after) {
    const context=await request('/api/project-spaces/context/'+encodeURIComponent(id)+'/'+encodeURIComponent(sid));
    if(!await engine.confirm({title:'Resume autopilot?',message:'The retained task will continue with the conversation’s current Project memory. Earlier context remains in its history.'}))return;
    try{await request(base(id)+'/autopilot/'+encodeURIComponent(sid)+'/resume',{expectedMembershipRevision:context.membershipRevision});after();}catch(e){room.notify(e.message);}
  }
  async function shareChatFile(execution,file) {
    const p=projects.find(p=>p.id===scopeOf(execution));if(!p)return;
    const d=dialog('Add file to '+p.name,`<form class="workspace-form"><label>Saved version<select name="version">${[...file.versions].reverse().map(v=>`<option value="${esc(v.id)}">${esc(new Date(v.createdAt).toLocaleString())}${v.id===file.latestVersionId?' · Latest':''}</option>`).join('')}</select></label><p>The Project receives its own copy and version history. Your Chat’s saved file stays available.</p><p role="alert"></p><button class="cr-primary">Add to project</button></form>`),form=d.querySelector('form'),operationId=crypto.randomUUID();
    form.onsubmit=async e=>{e.preventDefault();form.querySelector('button').disabled=true;try{await request(base(p.id)+'/files/copy',{sourceOwnerId:execution.id,fileId:file.id,versionId:form.elements.version.value,operationId});d.close();room.notify('Saved to '+p.name+' Files.');}catch(e){form.querySelector('[role=alert]').textContent=e.message;}finally{form.querySelector('button').disabled=false;}};
  }
  async function importArtifact(item) {
    if(!await engine.confirm({title:'Add output to Project Files?',message:item.title+' will be saved with its source conversation. The retained original stays available.'}))return;
    try{const context=await request('/api/project-spaces/context/'+encodeURIComponent(item.projectId)+'/'+encodeURIComponent(item.sessionId));if(!context.spaceId)throw new Error('Add this conversation to a Project first');await request(base(context.spaceId)+'/files/import-artifact',{executionId:item.projectId,sessionId:item.sessionId,artifactId:item.id,operationId:crypto.randomUUID()});room.notify('Output saved to Project Files.');}catch(e){room.notify(e.message);}
  }
  async function editBrief(p) {
    try{const found=await request('/api/memory/search?'+new URLSearchParams({spaceId:p.id,tag:'project-brief',scope:'space',access:'library',limit:100}));
      const entry=found.items.find(e=>(e.spaceId||e.projectId)===p.id&&e.status==='confirmed');
      room.editMemory(entry||{title:p.name+' brief',spaceId:p.id,scope:'space',kind:'context',status:'confirmed',pinned:true,tags:['project-brief']},()=>route());
    }catch(e){room.notify(e.message);}
  }
  async function handoff(mode, fresh = false) {
    const state=engine.state(), source=state.projects.find(p=>p.id===state.projectId), sid=state.sessionId;
    if(!source||!sid)return;
    const parent=projects.find(p=>p.id===scopeOf(source,sid));
    const d=dialog(fresh?'Start a fresh linked Chat':mode==='work'?'Continue in Work':'Discuss in Chat','<p class="rc-chat-empty" role="status">Loading saved context…</p>');
    try {
      const history=await request('/api/conversations/history?'+new URLSearchParams({projectId:source.id,sessionId:sid,limit:12}));
      const fileSets=await Promise.all([...(parent?[request(base(parent.id)+'/files').then(data=>({ownerId:parent.id,...data}))]:[]),...(source.kind==='chat'&&parent?[request('/api/chats/'+source.id+'/files').then(data=>({ownerId:source.id,...data}))]:[])]);
      if(!d.open)return;
      const files=fileSets.flatMap(set=>set.files.filter(f=>!f.removed).map(file=>({file,ownerId:set.ownerId}))),rows=Array.isArray(history)?history:history.rows||[];
      const brief=fresh?'':rows.filter(r=>['user','assistant'].includes(r.role)).slice(-6).map(r=>r.role.toUpperCase()+': '+r.text.slice(0,1600)).join('\n\n');
      d.querySelector('[role=status]').remove();d.insertAdjacentHTML('beforeend',`<form class="workspace-form"><p>A new ${mode==='work'?'Work':'Chat'} conversation starts from the brief you review here.${fresh?' Earlier provider context is left in the source conversation.':''}</p><label>Name<input name="name" value="${esc((fresh?'Fresh: ':mode==='work'?'Continue: ':'Discuss: ')+(source.conversations.find(c=>c.sessionId===sid)?.title||source.name))}" maxlength="300"></label>${mode==='work'?workChoices(parent?.defaultWorkProjectId||(parent?.workProjects?.length===1?parent.workProjects[0].id:'')):''}${controlsMarkup}<label>Task brief<textarea name="brief" rows="8" required maxlength="50000" placeholder="What should the next conversation do?">${esc(brief)}</textarea></label><label class="workspace-check"><input type="checkbox" name="source" checked>Link the source conversation</label><fieldset><legend>Saved files</legend>${files.map(({file,ownerId},i)=>`<label class="workspace-check"><input type="checkbox" data-file-choice="${i}"><span>${esc(file.name)}${ownerId!==parent?.id?' · Copies this Chat file into Project Files':''}</span></label><select aria-label="Version of ${esc(file.name)}" data-file-version="${i}">${[...file.versions].reverse().map(v=>`<option value="${esc(v.id)}">${esc(new Date(v.createdAt).toLocaleString())}${v.id===file.latestVersionId?' · Latest':''}</option>`).join('')}</select>`).join('')||'<p>No saved files selected.</p>'}</fieldset><fieldset><legend>Reviewed memory</legend><div data-memories></div></fieldset><p role="alert"></p><button class="cr-primary">Create ${mode} and send brief</button></form>`);
      const form=d.querySelector('form'),requestId=crypto.randomUUID();controls(form,parent?.defaults?.[mode]);
      const refreshMemories=async()=>{const data=await request('/api/memory/context?'+new URLSearchParams({projectId:source.id,sessionId:sid,provider:form.elements.provider.value}));if(d.open)form.querySelector('[data-memories]').innerHTML=data.items.map(m=>`<label class="workspace-check"><input type="checkbox" data-memory-id="${esc(m.id)}" data-revision="${m.revision}" ${fresh?'':'checked'}><span>${esc(m.title)} · v${m.revision}</span></label>`).join('')||'<p>No eligible confirmed memories.</p>';};
      form.elements.provider.addEventListener('change',()=>refreshMemories().catch(e=>room.notify(e.message)));await refreshMemories();
      form.onsubmit=async e=>{e.preventDefault();const f=form.elements,button=form.querySelector('.cr-primary');button.disabled=true;
        try {const op=await request('/api/project-spaces/handoffs',{requestId,sourceProjectId:source.id,sourceSessionId:sid,mode,spaceId:parent?.id,workProjectId:mode==='work'?f.workProjectId.value:undefined,name:f.name.value,brief:f.brief.value,choices:{provider:f.provider.value,model:f.model.value,effort:f.effort.value,account:f.account.value},sources:f.source.checked?[{projectId:source.id,sessionId:sid}]:[],memories:[...form.querySelectorAll('[data-memory-id]:checked')].map(x=>({id:x.dataset.memoryId,revision:Number(x.dataset.revision)})),fileRefs:[...form.querySelectorAll('[data-file-choice]:checked')].map(x=>{const i=Number(x.dataset.fileChoice),{file,ownerId}=files[i];return {ownerId,fileId:file.id,versionId:form.querySelector(`[data-file-version="${i}"]`).value,name:file.name};})});
          await engine.reloadProjects();d.close();await window.rcProjectSpaces.openConversation(op.target.projectId,op.target.sessionId);room.notify(op.status==='uncertain'?'Delivery needs review in Message delivery. The brief was not resent.':'Handoff saved. The brief is ready for the new conversation.');
        }catch(e){form.querySelector('[role=alert]').textContent=e.message;}finally{button.disabled=false;}
      };
    }catch(e){d.querySelector('[role=status]').textContent=e.message;}
  }
  let linksIdentity='';
  // The conversation menu is built when it opens, so the links are fetched with the
  // rest of the conversation context and kept for it.
  let handoffLinks=[];
  async function updateHandoffLinks(pid,sid) {
    const identity=pid+'::'+sid;if(linksIdentity===identity)return;linksIdentity=identity;handoffLinks=[];
    try{const ops=await request('/api/project-spaces/handoffs?'+new URLSearchParams({projectId:pid,sessionId:sid}));if(linksIdentity!==identity)return;
      handoffLinks=ops.slice(-6).map(op=>{const other=op.target?.projectId===pid&&op.target?.sessionId===sid?{projectId:op.input.sourceProjectId,sessionId:op.input.sourceSessionId}:op.target;const p=engine.state().projects.find(p=>p.id===other?.projectId);return p?{label:'Open linked '+(p.kind==='chat'?'Chat':'Work')+': '+p.name,path:conversationPath(p,other.sessionId)}:null;}).filter(Boolean);
    }catch{linksIdentity='';}
  }
  let contextSignature='';
  // Everything the old context bar carried has a home of its own now: the Project in
  // the breadcrumb, its files and membership on the Project page, memory and the
  // handoffs in the conversation menu, and Tools in the conversation topbar.
  function updateContext() {
    if (!enabled || !mounted) return;
    const state = engine.state(), p = state.projects.find(p => p.id === state.projectId), parentId = scopeOf(p,state.sessionId);
    const parent = projects.find(p => p.id === parentId), tools = $('chatTools');
    const live = !!state.sessionId && !!p && room.isOpen();
    if (tools) tools.hidden = !live || p?.kind === 'chat';
    if (!live) {contextSignature='';return;}
    const signature=JSON.stringify([p.id,p.name,parent?.id,parent?.name,parent?.workspaceConfigured,p.conversations?.find(c=>c.sessionId===state.sessionId)?.membershipRevision,state.sessionId]);if(signature===contextSignature)return;contextSignature=signature;
    if (tools) tools.onclick = () => chat.tools(p.id);
    linksIdentity=''; updateHandoffLinks(p.id,state.sessionId);
  }
  document.addEventListener('click', event => {
    if (!mounted || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target.closest('a[data-space-link]'); if (!a) return;
    event.preventDefault(); a.closest('dialog')?.close(); navigate(new URL(a.href).pathname);
  });
  document.addEventListener('click', event => {
    if (!enabled || !document.body.classList.contains('rc-spaces-view')) return;
    if (event.target.closest('a[data-chat-link]')) leave();
    if (!window.rcWorkspace?.ready()&&event.target.closest('.cr-primary-nav button, #crHome, #focusHome, #focusBack')) { history.pushState({}, '', '/work'); leave(); }
  }, true);
  window.addEventListener('popstate', () => { if (mounted) route(); });
  document.addEventListener('x056:state', updateContext);
  document.addEventListener('x056:costs',()=>{if(activeTab==='overview'&&$('rcOverviewCost'))updateOverviewCost(activeId);});
  document.addEventListener('x056:event',event=>{if(enabled&&event.detail.kind==='projects')load().then(()=>{updateContext();room.refresh();}).catch(e=>room.notify(e.message));});
  document.addEventListener('x056:mode', () => setTimeout(updateContext, 0));
  return {
    // The conversation context bar is gone; these belong with the other
    // conversation-level actions, in the conversation menu.
    conversationItems:()=>{
      const state=engine.state(),source=state.projects.find(p=>p.id===state.projectId),sid=state.sessionId;
      if(!enabled||!source||!sid)return [];
      const parent=projects.find(p=>p.id===scopeOf(source,sid)),isChat=source.kind==='chat';
      const items=[{label:isChat?'Continue in Work':'Discuss in Chat',icon:isChat?'terminal':'chat',disabled:isChat&&!parent?.workspaceConfigured,run:()=>handoff(isChat?'work':'chat')}];
      if(isChat)items.push({label:'Start a fresh linked Chat',icon:'compose',run:()=>handoff('chat',true)});
      items.push({label:'Change Project',icon:'folder',run:()=>membershipDialog(source,undefined,isChat?undefined:sid)});
      for(const l of handoffLinks)items.push({label:l.label,icon:'chat',run:()=>navigate(l.path)});
      return items;
    },
    enabled: () => enabled, list:()=>projects, scopeOf, handles, navigate, leave:()=>{generation++;leave();}, newWork:pid=>{const execution=engine.state().projects.find(p=>p.id===pid);if(execution?.cwd)newConversation(projects.find(p=>p.id===execution.workSpaceId),'work',pid);}, createFromWork:pid=>createProject(pid), newProject:()=>createProject(), membershipDialog, conversationPath, reviewQueue, resumeAutopilot, shareChatFile, importArtifact,
    openConversation: (pid, sid) => { const p = engine.state().projects.find(p => p.id === pid); if (p) return navigate(conversationPath(p, sid)); },
    init: async () => { try { const data = await load(); enabled = data.enabled; mount(); await route(); updateContext(); } catch (error) { room.notify(error.message); } },
  };
};
