/* Parent Project views reuse the mounted conversation, memory and file services. */
window.createProjectSpaces = function (engine, room, chat) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const path = (id, tab = 'chat') => '/projects' + (id ? '/' + encodeURIComponent(id) + '/' + tab : '');
  const conversationPath = (p, sid) => p.kind === 'chat' ? '/chat/' + encodeURIComponent(p.id) : '/work/' + encodeURIComponent(p.id) + '/' + encodeURIComponent(sid);
  const handles = pathname => enabled && /^\/(projects|work)(\/|$)/.test(pathname);
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
    d.innerHTML = `<header><h2 id="${label}">${esc(title)}</h2><button class="cr-icon" type="button" aria-label="Close">×</button></header>${body}`;
    d.querySelector('header button').onclick = () => d.close();
    d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
    d.onclose = () => d.remove(); document.body.append(d); d.showModal(); return d;
  }
  function mount() {
    if (mounted) return; mounted = true;
    $('crBoardTab').insertAdjacentHTML('beforebegin', link('/projects', icon('folder') + '<span>Projects</span>', 'rc-project-nav-link'));
    document.querySelector('.rc-project-nav-link').id = 'crSpacesTab';
    const panel = document.createElement('section'); panel.id = 'rcProjectPage'; panel.className = 'cr-page'; panel.hidden = true; $('crWorkspace').append(panel);
    const context = document.createElement('div'); context.id = 'rcProjectContext'; context.hidden = true;
    document.querySelector('.composer-wrap').prepend(context);
    $('crBoardTab').innerHTML = icon('menu') + '<span>Work</span>';
    const work = document.createElement('a'); for (const attr of $('crBoardTab').attributes) work.setAttribute(attr.name, attr.value);
    work.href = '/work'; work.dataset.spaceLink = ''; work.innerHTML = $('crBoardTab').innerHTML; $('crBoardTab').replaceWith(work);
    room.refresh(); updateChatFilter();
  }
  function restoreMemory() { const memory = $('crMemory'); if (memory && memory.parentNode !== $('crWorkspace')) $('crWorkspace').append(memory); }
  function leave() {
    restoreMemory(); document.body.classList.remove('rc-spaces-view'); $('rcProjectPage').hidden = true;
    $('crSpacesTab').removeAttribute('aria-current');
  }
  async function navigate(url, replace = false) {
    if (location.pathname !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
    if (url.startsWith('/chat')) { leave(); return chat?.navigate(url); }
    return route();
  }
  async function load() { const result = await request('/api/project-spaces'); projects = result.projects || []; if(mounted)updateChatFilter(); return result; }
  function updateChatFilter() {
    if(!$('rcChatSearch'))return; let select=$('rcChatProjectFilter');
    if(!select){select=document.createElement('select');select.id='rcChatProjectFilter';select.setAttribute('aria-label','Filter chats by project');$('rcChatSearch').after(select);select.onchange=()=>chat.refresh();}
    const selected=select.value;select.innerHTML='<option value="">All Chat</option><option value="standalone">Standalone Chat</option>'+projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');select.value=selected;chat.refresh();
  }
  async function route() {
    if (!enabled) return;
    const version = ++generation, url = location.pathname;
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
        } else { room.showBoard(); $('crBoardTab').setAttribute('aria-current', 'page'); }
        return;
      }
      room.showBoard(); document.body.classList.add('rc-spaces-view'); $('rcProjectPage').hidden = false;
      $('crSpacesTab').setAttribute('aria-current', 'page'); $('crBoardTab').removeAttribute('aria-current');
      $('rcProjectPage').innerHTML = '<p class="cr-empty" role="status">Loading Project…</p>';
      await load(); if (generation !== version || location.pathname !== url) return;
      activeId = segments[1] || ''; activeTab = segments[2] || 'chat';
      if (!activeId) renderList();
      else {
        const project = projects.find(p => p.id === activeId);
        if (!project) throw new Error('Project unavailable');
        if (!['chat', 'work', 'files', 'memory', 'settings'].includes(activeTab)) throw new Error('Project page unavailable');
        if (segments.length === 2) history.replaceState({}, '', path(activeId));
        await renderProject(project);
      }
      $('rcProjectPage').querySelector('h1')?.focus({ preventScroll: true });
    } catch (error) {
      room.showBoard(); document.body.classList.add('rc-spaces-view'); $('rcProjectPage').hidden = false;
      $('rcProjectPage').innerHTML = `<div class="cr-empty" role="alert"><h1 tabindex="-1">Page unavailable</h1><p>${esc(error.message)}</p>${link('/projects', 'Open Projects', 'cr-secondary')}</div>`;
    } finally { navigating = false; updateContext(); }
  }
  function renderList() {
    $('rcProjectPage').innerHTML = `<div class="cr-heading"><div><h1 tabindex="-1">Projects</h1><p>A shared home for conversations, files, and reviewed memory.</p></div><button class="cr-primary" id="rcSpaceNew">${icon('plus')} New project</button></div><div class="rc-space-list-controls"><label class="cr-search">${icon('search')}<input id="rcSpaceSearch" type="search" placeholder="Find a project" aria-label="Find a project"></label><label><input id="rcSpaceArchives" type="checkbox"> Show archived</label></div><div class="rc-space-grid" id="rcSpaceList"></div>`;
    const render = () => {
      const query = $('rcSpaceSearch').value.toLowerCase(), archived = $('rcSpaceArchives').checked;
      $('rcSpaceList').innerHTML = projects.filter(p => !!p.archivedAt === archived && p.name.toLowerCase().includes(query)).map(p => link(path(p.id), `${icon('folder')}<h2>${esc(p.name)}</h2><p>${p.chats.length} Chat · ${(p.conversations || []).length} Work</p><small>${p.activity.running || p.activity.background ? `${p.activity.running} running · ${p.activity.background} background` : p.workspaceConfigured ? 'Work workspace ready' : 'Chat and files ready'}</small>`, 'rc-space-card')).join('') || '<p class="cr-empty">No projects found.</p>';
    };
    $('rcSpaceSearch').oninput = $('rcSpaceArchives').onchange = render; $('rcSpaceNew').onclick = createProject; render();
  }
  function createProject() {
    const d = dialog('New project', '<form class="workspace-form"><label>Name<input name="name" required maxlength="300" placeholder="Proposal"></label><p>Start with Chat and Files. Add a Work workspace when you need it.</p><p role="alert"></p><button class="cr-primary">Create project</button></form>');
    const form = d.querySelector('form'), requestId = crypto.randomUUID();
    form.onsubmit = async e => { e.preventDefault(); form.querySelector('button').disabled = true;
      try { const p = await request('/api/project-spaces', { requestId, name: form.elements.name.value }); await engine.reloadProjects(); d.close(); await navigate(path(p.id)); }
      catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { form.querySelector('button').disabled = false; }
    };
  }
  async function renderProject(p) {
    $('rcProjectPage').innerHTML = `<div class="rc-space-breadcrumb">${link('/projects', 'Projects')}<span>/</span><span>${esc(p.name)}</span></div><div class="cr-heading"><div><h1 tabindex="-1">${esc(p.name)}</h1><p>${p.archivedAt ? 'Archived · saved history and files are retained' : `${p.activity.running} running · ${p.activity.background} background · ${p.activity.queued} queued`}</p></div>${link(path(p.id, 'settings'), icon('gear') + ' Settings', 'cr-secondary')}</div><nav class="rc-space-tabs" aria-label="Project sections">${['chat', 'work', 'files', 'memory'].map(tab => `<a href="${path(p.id, tab)}" data-space-link ${tab === activeTab ? 'aria-current="page"' : ''}>${icon({chat:'chat',work:'menu',files:'file',memory:'snippet'}[tab])}${tab[0].toUpperCase() + tab.slice(1)}</a>`).join('')}</nav><div id="rcProjectBody"></div>`;
    if (activeTab === 'chat' || activeTab === 'work') renderConversations(p, activeTab);
    if (activeTab === 'files') await renderFiles(p);
    if (activeTab === 'memory') {
      $('rcProjectBody').innerHTML='<div class="rc-space-toolbar"><button class="cr-primary" id="rcProjectBrief">Review project brief</button><span class="rc-space-note">Confirmed memory informs future Chat and Work turns.</span></div>';
      $('rcProjectBrief').onclick=()=>editBrief(p);
      room.showProjectMemory(p.id); $('rcProjectBody').append($('crMemory')); $('crMemory').hidden = false;
      document.body.classList.add('rc-spaces-view'); $('rcProjectPage').hidden = false;
      $('crSpacesTab').setAttribute('aria-current', 'page');
    }
    if (activeTab === 'settings') renderSettings(p);
  }
  function renderConversations(p, mode) {
    const rows = mode === 'chat' ? p.chats.map(chat => ({ p: chat, c: chat.conversations[0] })) : (p.conversations || []).map(c => ({ p, c }));
    $('rcProjectBody').innerHTML = `<div class="rc-space-toolbar"><label class="cr-search">${icon('search')}<input id="rcSpaceConversationSearch" type="search" placeholder="Search ${mode}" aria-label="Search ${mode}"></label>${mode === 'chat' ? '<button class="cr-secondary" id="rcSpaceAddChat">Add existing chat</button>' : ''}<button class="cr-primary" id="rcSpaceNewConversation" ${p.archivedAt || (mode === 'work' && !p.cwd) ? 'disabled' : ''}>New ${mode}</button></div>${mode === 'work' && !p.cwd ? `<div class="cr-empty"><h2>Add a Work workspace</h2><p>Chat and Files are ready. Choose a workspace before starting Work.</p>${link(path(p.id, 'settings'), 'Set up workspace', 'cr-primary')}</div>` : ''}<div class="rc-space-conversations" id="rcSpaceConversations"></div>`;
    const render = () => {
      const q = $('rcSpaceConversationSearch').value.toLowerCase();
      $('rcSpaceConversations').innerHTML = rows.filter(({ c }) => c.title.toLowerCase().includes(q)).map(({ p: execution, c }) => link(conversationPath(execution, c.sessionId), `${icon(mode === 'chat' ? 'chat' : 'menu')}<span><strong>${esc(c.title || 'Untitled conversation')}</strong><small>${c.provider === 'codex' ? 'Codex' : 'Claude'}${execution.runningSessionIds.includes(c.sessionId) ? ' · Running' : execution.backgroundSessionIds.includes(c.sessionId) ? ' · Background work' : ''}</small></span>${icon('right')}`, 'rc-space-conversation')).join('') || '<p class="cr-empty">No conversations yet.</p>';
    };
    $('rcSpaceConversationSearch').oninput = render;
    $('rcSpaceNewConversation').onclick = () => newConversation(p, mode);
    if ($('rcSpaceAddChat')) $('rcSpaceAddChat').onclick = () => membershipDialog(null, p.id);
    render();
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
  function newConversation(p, mode) {
    const d = dialog('New ' + mode, `<form class="workspace-form"><label>Name<input name="name" placeholder="New ${mode}" maxlength="300"></label>${controlsMarkup}<p role="alert"></p><button class="cr-primary">Create ${mode}</button></form>`), form = d.querySelector('form'), requestId = crypto.randomUUID();
    controls(form, p.defaults?.[mode]);
    form.onsubmit = async event => { event.preventDefault(); const f = form.elements; form.querySelector('button').disabled = true;
      try {
        const input = { requestId, name: f.name.value || undefined, provider: f.provider.value, model: f.model.value, effort: f.effort.value, account: f.account.value || undefined };
        const result = await request(mode === 'chat' ? '/api/chats' : base(p.id) + '/work', mode === 'chat' ? { ...input, parentProjectId: p.id } : input);
        await engine.reloadProjects(); d.close(); await navigate(mode === 'chat' ? '/chat/' + result.id : conversationPath(p, result.sessionId));
      } catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { form.querySelector('button').disabled = false; }
    };
  }
  async function renderFiles(p) {
    const body = $('rcProjectBody'), data = await request(base(p.id) + '/files');
    if (activeId !== p.id || activeTab !== 'files') return;
    body.innerHTML = `<div class="rc-space-toolbar"><h2>Project files</h2><button class="cr-primary" id="rcSpaceUpload" ${p.archivedAt ? 'disabled' : ''}>Upload files</button><input id="rcSpaceUploadInput" type="file" multiple hidden></div><p class="rc-space-note">Saved versions stay available across Chat, Work, and account changes.</p><div id="rcSpaceUploadStatus" role="status"></div><div class="rc-space-files">${data.files.map(file => `<article data-project-file="${esc(file.id)}" class="rc-space-file ${file.removed ? 'removed' : ''}">${icon('file')}<div><strong>${esc(file.name)}</strong><small>${file.versions.length} saved version${file.versions.length === 1 ? '' : 's'}${file.sourceFileId ? ' · Shared from Chat' : file.sourceArtifactId ? ' · Work output' : ' · Project upload'}${file.removed ? ' · Removed' : ''}</small></div><button data-versions class="cr-secondary">Versions</button><button data-attach class="cr-secondary" ${file.removed || p.archivedAt ? 'disabled' : ''}>Use in conversation</button><button data-remove class="cr-icon" aria-label="${file.removed ? 'Restore' : 'Remove'} ${esc(file.name)}">${icon(file.removed ? 'history' : 'x')}</button></article>`).join('') || '<p class="cr-empty">Upload a document or add a saved Chat or Work output.</p>'}</div>`;
    $('rcSpaceUpload').onclick = () => $('rcSpaceUploadInput').click();
    $('rcSpaceUploadInput').onchange = () => upload(p, [...$('rcSpaceUploadInput').files]);
    body.querySelectorAll('[data-project-file]').forEach(row => {
      const file = data.files.find(f => f.id === row.dataset.projectFile);
      row.querySelector('[data-versions]').onclick = () => versionsDialog(p, file);
      row.querySelector('[data-attach]').onclick = () => attachDialog(p, file, file.latestVersionId);
      row.querySelector('[data-remove]').onclick = action(async () => { await request(base(p.id) + '/files/' + file.id, { removed: !file.removed }); await renderFiles(p); });
    });
    renderUploads();
  }
  function renderUploads() {
    const node = $('rcSpaceUploadStatus'); if (!node) return;
    node.innerHTML = [...uploads.values()].filter(j => j.ownerId === activeId).map(j => `<div class="rc-space-upload"><span>${esc(j.names)} · ${esc(j.state)}${j.progress === undefined ? '' : ' ' + j.progress + '%'}</span>${j.state === 'uploading' ? `<button data-cancel="${j.id}">Cancel</button>` : j.state !== 'saved' ? `<button data-retry="${j.id}">Retry</button>` : ''}</div>`).join('');
    node.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => uploads.get(b.dataset.cancel)?.xhr.abort());
    node.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => runUpload(uploads.get(b.dataset.retry)));
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
  function versionsDialog(p, file) {
    const d = dialog(file.name, `<div class="rc-space-version-list">${[...file.versions].reverse().map((v, i) => `<article data-version="${esc(v.id)}"><strong>${i === 0 ? 'Latest version' : 'Earlier version'}</strong><small>${esc(new Date(v.createdAt).toLocaleString())} · ${Math.ceil(v.bytes / 1024)} KiB</small><div><button data-download class="cr-secondary">Download</button><button data-preview class="cr-secondary">Preview</button><button data-attach class="cr-secondary">Attach</button><button data-restore class="cr-secondary" ${p.archivedAt ? 'disabled' : ''}>Restore as new version</button></div></article>`).join('')}</div><div id="rcSpacePreview" role="status"></div>`);
    const urls = []; d.addEventListener('close', () => urls.forEach(URL.revokeObjectURL));
    const fetchBlob = async url => { const response = await engine.api(url); if (!response.ok) throw new Error('File unavailable'); const blob = await response.blob(), object = URL.createObjectURL(blob); urls.push(object); return { blob, object }; };
    d.querySelectorAll('[data-version]').forEach(row => {
      const v = file.versions.find(v => v.id === row.dataset.version), root = base(p.id) + '/files/' + file.id + '/versions/' + v.id;
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
    const rows = [...p.chats.flatMap(c => c.conversations.map(conversation => ({ p: c, c: conversation }))), ...(p.conversations || []).map(c => ({ p, c }))];
    const d = dialog('Use file in a conversation', `<div class="rc-space-version-list">${rows.map(({ p: execution, c }) => `<button class="rc-space-conversation" data-execution="${esc(execution.id)}" data-session="${esc(c.sessionId)}">${icon(execution.kind === 'chat' ? 'chat' : 'menu')}<span><strong>${esc(c.title)}</strong><small>${execution.kind === 'chat' ? 'Chat' : 'Work'}</small></span></button>`).join('') || '<p>Create a Chat or Work conversation first.</p>'}</div>`);
    d.querySelectorAll('[data-execution]').forEach(b => b.onclick = action(async () => {
      engine.attachSaved(b.dataset.execution, b.dataset.session, { fileId: file.id, versionId, ownerId: p.id, name: file.name });
      const execution = engine.state().projects.find(x => x.id === b.dataset.execution); d.close(); await navigate(conversationPath(execution, b.dataset.session));
    }));
  }
  function renderSettings(p) {
    $('rcProjectBody').innerHTML = `<form class="workspace-form rc-space-settings" id="rcSpaceSettings"><label>Project name<input name="name" value="${esc(p.name)}" required maxlength="300"></label><label>Work workspace<input name="cwd" value="${esc(p.cwd || '')}" placeholder="Choose a directory under the workspace root"></label><p class="rc-space-note">The Work directory stays separate from every Chat’s managed files.</p><fieldset><legend>Defaults for new conversations</legend><label>Mode<select name="mode"><option value="chat">Chat</option><option value="work">Work</option></select></label>${controlsMarkup}</fieldset><label>Required tools<textarea name="tools" rows="3" placeholder="One key per line, such as skill:rc-documents">${esc((p.requiredTools || []).map(r => r.key).join('\n'))}</textarea></label><p class="rc-space-note">Each account must verify required plugins, MCP servers, and skills in the conversation’s own directory.</p><p role="alert"></p><div class="rc-space-toolbar"><button class="cr-primary">Save settings</button><button type="button" class="cr-secondary" id="rcSpaceMemorySettings">Memory settings</button><button type="button" class="cr-secondary" id="rcSpaceArchive">${p.archivedAt ? 'Restore project' : 'Archive project'}</button></div></form>`;
    const form = $('rcSpaceSettings'), f = form.elements, defaults = structuredClone(p.defaults || {}); let mode = 'chat'; controls(form, defaults.chat);
    const saveMode = () => { defaults[mode] = { provider: f.provider.value, model: f.model.value, effort: f.effort.value, account: f.account.value || undefined }; };
    f.mode.onchange = () => { saveMode(); mode = f.mode.value; controls(form, defaults[mode]); };
    form.onsubmit = async e => { e.preventDefault(); saveMode(); form.querySelector('button').disabled = true;
      try { await request(base(p.id), { expectedRevision: p.revision || 0, name: f.name.value, cwd: f.cwd.value || undefined, defaults, requiredTools: f.tools.value.split('\n').map(s => s.trim()).filter(Boolean).map(key => ({ key })) }); await engine.reloadProjects(); await route(); }
      catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { form.querySelector('button').disabled = false; }
    };
    $('rcSpaceMemorySettings').onclick=()=>room.memorySettings();
    $('rcSpaceArchive').onclick = action(async () => {
      if (!await engine.confirm({ title: p.archivedAt ? 'Restore project?' : 'Archive project?', message: `${p.chats.length} Chat, ${(p.conversations||[]).length} Work and ${p.activity.queued} queued messages. History and files stay available. Scheduled jobs and autopilots pause; restoring does not resume them.` })) return;
      await request(base(p.id) + '/archive', { expectedRevision: p.revision || 0, operationId: crypto.randomUUID(), archived: !p.archivedAt }); await engine.reloadProjects(); await route();
    });
  }
  async function membershipDialog(execution, parentId) {
    try { await load(); await engine.reloadProjects(); } catch (e) { room.notify(e.message); return; }
    const chats = engine.state().projects.filter(p => p.kind === 'chat' && !p.archivedAt);
    const d = dialog(execution ? 'Move chat' : 'Add existing chat', `<form class="workspace-form">${execution ? '' : `<label>Chat<select name="chatId">${chats.map(c => `<option value="${esc(c.id)}">${esc(c.conversations?.[0]?.title || c.name)}</option>`).join('')}</select></label>`}<label>Project<select name="parent"><option value="">Standalone Chat</option>${projects.filter(p => !p.archivedAt).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><p>Future turns use the selected Project’s memory. Earlier context remains in the provider’s conversation history. Waiting messages need review after a move.</p><p>Start a fresh conversation if you need a clean context.</p><p role="alert"></p><button class="cr-primary">Save membership</button></form>`);
    const form = d.querySelector('form'), operationId = crypto.randomUUID(); form.elements.parent.value = parentId || execution?.parentProjectId || '';
    form.onsubmit = async e => { e.preventDefault(); const c = execution || chats.find(c => c.id === form.elements.chatId.value); if (!c) return;
      form.querySelector('button').disabled = true;
      try { await request('/api/project-spaces/membership/' + c.id, { parentProjectId: form.elements.parent.value || null, expectedRevision: c.membershipRevision || 0, operationId }); await engine.reloadProjects(); d.close(); if (handles(location.pathname)) await route(); else updateContext(); }
      catch (error) { form.querySelector('[role=alert]').textContent = error.message; } finally { form.querySelector('button').disabled = false; }
    };
  }
  async function reviewQueue(id, item, after) {
    await engine.reloadProjects();const p=engine.state().projects.find(p=>p.id===id),parent=projects.find(x=>x.id===(p.kind==='chat'?p.parentProjectId:p.id));
    const d=dialog('Review waiting message',`<form class="workspace-form"><p>${esc(item.contextReview.reason)}. Future turns use ${esc(parent?.name||'local conversation')} memory. Earlier context remains in provider history.</p><button type="button" class="cr-secondary" data-context>Inspect memory context</button><label>Message<textarea name="text" rows="6" required>${esc(item.text)}</textarea></label><fieldset><legend>Keep these saved versions</legend>${(item.fileRefs||[]).map((ref,i)=>`<label class="workspace-check"><input type="checkbox" data-ref="${i}" checked><span>${esc(ref.name||ref.fileId)} · ${esc(ref.versionId)}</span></label>`).join('')||'<p>No attached files.</p>'}</fieldset><p>Uncheck files from a previous Project to remove them. Remaining attachments are checked before dispatch.</p><p role="alert"></p><button class="cr-primary">Save review and resume</button></form>`);
    d.querySelector('[data-context]').onclick=()=>room.memoryContext({projectId:id,sessionId:item.sessionId});const form=d.querySelector('form');
    form.onsubmit=async e=>{e.preventDefault();form.querySelector('.cr-primary').disabled=true;try{const fileRefs=[...form.querySelectorAll('[data-ref]:checked')].map(x=>item.fileRefs[Number(x.dataset.ref)]);await request(base(id)+'/queue/'+item.id+'/review',{expectedMembershipRevision:p.membershipRevision||0,review:{expectedText:item.text,text:form.elements.text.value,fileRefs}});d.close();after();}catch(e){form.querySelector('[role=alert]').textContent=e.message;}finally{form.querySelector('.cr-primary').disabled=false;}};
  }
  async function resumeAutopilot(id,sid,after) {
    await engine.reloadProjects();const p=engine.state().projects.find(p=>p.id===id);
    if(!await engine.confirm({title:'Resume autopilot?',message:'The retained task will continue with the conversation’s current Project memory. Earlier context remains in its history.'}))return;
    try{await request(base(id)+'/autopilot/'+encodeURIComponent(sid)+'/resume',{expectedMembershipRevision:p.membershipRevision||0});after();}catch(e){room.notify(e.message);}
  }
  async function shareChatFile(execution,file) {
    const p=engine.state().projects.find(p=>p.id===execution.parentProjectId);if(!p)return;
    const d=dialog('Add file to '+p.name,`<form class="workspace-form"><label>Saved version<select name="version">${[...file.versions].reverse().map(v=>`<option value="${esc(v.id)}">${esc(new Date(v.createdAt).toLocaleString())}${v.id===file.latestVersionId?' · Latest':''}</option>`).join('')}</select></label><p>The Project receives its own copy and version history. Your Chat’s saved file stays available.</p><p role="alert"></p><button class="cr-primary">Add to project</button></form>`),form=d.querySelector('form'),operationId=crypto.randomUUID();
    form.onsubmit=async e=>{e.preventDefault();form.querySelector('button').disabled=true;try{await request(base(p.id)+'/files/copy',{sourceOwnerId:execution.id,fileId:file.id,versionId:form.elements.version.value,operationId});d.close();room.notify('Saved to '+p.name+' Files.');}catch(e){form.querySelector('[role=alert]').textContent=e.message;}finally{form.querySelector('button').disabled=false;}};
  }
  async function importArtifact(item) {
    if(!await engine.confirm({title:'Add output to Project Files?',message:item.title+' will be saved with its source conversation. The retained original stays available.'}))return;
    try{await request(base(item.projectId)+'/files/import-artifact',{executionId:item.projectId,sessionId:item.sessionId,artifactId:item.id,operationId:crypto.randomUUID()});room.notify('Output saved to Project Files.');}catch(e){room.notify(e.message);}
  }
  async function editBrief(p) {
    try{const found=await request('/api/memory/search?'+new URLSearchParams({projectId:p.id,tag:'project-brief',scope:'project',access:'library',limit:100}));
      const entry=found.items.find(e=>e.projectId===p.id&&e.status==='confirmed');
      room.editMemory(entry||{title:p.name+' brief',projectId:p.id,scope:'project',kind:'context',status:'confirmed',pinned:true,tags:['project-brief']},()=>route());
    }catch(e){room.notify(e.message);}
  }
  function updateContext() {
    if (!enabled || !mounted) return;
    const state = engine.state(), p = state.projects.find(p => p.id === state.projectId), parentId = p?.kind === 'chat' ? p.parentProjectId : p?.id;
    const parent = state.projects.find(p => p.id === parentId && p.kind !== 'chat'), host = $('rcProjectContext');
    host.hidden = !state.sessionId || !p || !room.isOpen();
    if (host.hidden) return;
    host.innerHTML = `${parent ? link(path(parent.id), icon('folder') + esc(parent.name), 'rc-space-parent') : '<span>Standalone Chat</span>'}${parent ? link(path(parent.id, 'files'), 'Project files', 'cr-secondary') : ''}${p.kind!=='chat'?'<button class="cr-secondary" data-tools>Tools</button>':''}<button class="cr-secondary" data-context>${parent ? 'Using project memory' : 'Memory context'}</button>${p.kind === 'chat' ? '<button class="cr-secondary" data-membership>Move chat</button>' : ''}`;
    host.querySelector('[data-context]').onclick = () => room.memoryContext({ projectId: p.id, sessionId: state.sessionId });
    if(host.querySelector('[data-tools]'))host.querySelector('[data-tools]').onclick=()=>chat.tools(p.id);
    const move = host.querySelector('[data-membership]'); if (move) move.onclick = () => membershipDialog(p);
  }
  document.addEventListener('click', event => {
    if (!enabled || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target.closest('a[data-space-link]'); if (!a) return;
    event.preventDefault(); navigate(new URL(a.href).pathname);
  });
  document.addEventListener('click', event => {
    if (!enabled || !document.body.classList.contains('rc-spaces-view')) return;
    if (event.target.closest('a[data-chat-link]')) leave();
    if (event.target.closest('.cr-primary-nav button, #crHome, #focusHome, #focusBack')) { history.pushState({}, '', '/work'); leave(); }
  }, true);
  window.addEventListener('popstate', () => { if (enabled) route(); });
  document.addEventListener('x056:state', updateContext);
  document.addEventListener('x056:mode', () => setTimeout(updateContext, 0));
  return {
    enabled: () => enabled, handles, navigate, membershipDialog, conversationPath, reviewQueue, resumeAutopilot, shareChatFile, importArtifact,
    openConversation: (pid, sid) => { const p = engine.state().projects.find(p => p.id === pid); if (p) return navigate(conversationPath(p, sid)); },
    init: async () => { try { const data = await load(); enabled = data.enabled; if (enabled) { mount(); await route(); updateContext(); } } catch (error) { room.notify(error.message); } },
  };
};
