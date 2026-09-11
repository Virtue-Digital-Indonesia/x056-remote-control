/* Free-form Chat uses the existing conversation engine and its delivery ledger. */
window.createRCChat = function (engine, room) {
  'use strict';
  const $ = id => document.getElementById(id), esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let enabled = false, mounted = false, active = '', selectedFile = '', selectedVersion = '', tab = 'files', files = [], sequence = 0, previewTimer, objectURLs = [], showArchived = false, showRemoved = false;
  const jobs = new Map();
  let routing = false, routeQueue = Promise.resolve();
  const chatPath = id => '/chat' + (id ? '/' + encodeURIComponent(id) : '');
  const inChat = () => /^\/chat(?:\/|$)/.test(location.pathname);
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
    const panel = document.createElement('aside'); panel.id = 'rcChatInspector'; panel.setAttribute('aria-label', 'Chat files and references');
    panel.innerHTML = `<header><strong>Workspace</strong><button class="cr-icon" id="rcChatPanelClose" aria-label="Close file panel">×</button></header><div class="rc-chat-tabs"><button data-chat-tab="files" aria-pressed="true">Files</button><button data-chat-tab="preview">Preview</button><button data-chat-tab="references">References</button></div><div id="rcChatUploads" role="status"></div><div id="rcChatPanelBody"></div>`;
    $('conversationSurface').append(panel);
    const tools = document.createElement('div'); tools.id = 'rcChatControls';
    tools.innerHTML = `<button class="cr-secondary" id="rcChatMenu">Chats</button><span id="rcChatProvider"></span><button class="cr-secondary" id="rcChatTools">Tools</button><button class="cr-secondary" id="rcChatReference">@ Reference</button><button class="cr-secondary" id="rcChatFiles">Files</button><button class="cr-icon" id="rcChatMore" aria-label="Chat actions">•••</button>`;
    document.querySelector('.composer-wrap').prepend(tools);
    $('rcChatNew').onclick = $('rcChatWelcomeNew').onclick = newChat;
    $('rcChatWelcomeMenu').onclick = () => document.body.classList.toggle('rc-chat-nav-open');
    $('rcChatAccounts').onclick = () => { leave(); room.showAccounts(); };
    $('rcChatSearch').oninput = renderChats;
    $('rcChatArchives').onclick = () => { showArchived = !showArchived; $('rcChatArchives').textContent = showArchived ? 'Active chats' : 'Archived chats'; renderChats(); };
    $('rcChatMenu').onclick = () => document.body.classList.toggle('rc-chat-nav-open');
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
        if (!inChat()) { leave(false, !!window.rcProjectSpaces?.handles(location.pathname)); return; }
        const path = location.pathname;
        await engine.reloadProjects();
        if (location.pathname !== path) return;
        const id = decodeURIComponent(location.pathname.split('/')[2] || '');
        const chat = engine.state().projects.find(p => p.kind === 'chat' && p.id === id);
        document.body.classList.add('rc-chat-active');
        document.body.classList.toggle('rc-chat-home-view', !chat);
        document.body.classList.remove('rc-chat-nav-open', 'rc-chat-panel-open');
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
    document.body.classList.remove('rc-chat-active','rc-chat-home-view','rc-chat-nav-open','rc-chat-panel-open');
    $('crChatTab')?.removeAttribute('aria-current'); cleanupPreview(); if (!keepRoom) room.showBoard();
  }
  function renderChats() {
    const query = $('rcChatSearch').value.toLowerCase(), state = engine.state();
    const filter = $('rcChatProjectFilter');
    const chats = state.projects.filter(p => p.kind === 'chat' && (!filter?.value || (filter.value==='standalone'?!p.spaceId:p.spaceId===filter.value)) && !!p.archivedAt === showArchived && (p.name + ' ' + p.conversations?.[0]?.title).toLowerCase().includes(query));
    chats.sort((a,b) => (b.conversations?.[0]?.lastMessageAt || b.conversations?.[0]?.createdAt || 0) - (a.conversations?.[0]?.lastMessageAt || a.conversations?.[0]?.createdAt || 0));
    $('rcChatArchives').textContent = showArchived ? 'Active chats' : 'Archived chats';
    $('rcChatList').innerHTML = chats.map(p => `<a class="rc-chat-item ${p.id === active ? 'selected' : ''}" href="${chatPath(p.id)}" data-chat-link data-chat="${esc(p.id)}" ${p.id === active ? 'aria-current="page"' : ''}><strong>${esc(p.conversations?.[0]?.title || p.name)}</strong><small>${esc(p.provider === 'codex' ? 'Codex' : 'Claude')}${p.running ? ' · Working' : ''}</small></a>`).join('') || '<p class="rc-chat-empty">No chats found.</p>';
  }
  function sync() {
    if (!mounted) return;
    if (!inChat()) { if (!routing && current() && room.isOpen() && !window.rcProjectSpaces?.handles(location.pathname)) navigate(chatPath(current().id)); return; }
    if (document.body.classList.contains('rc-chat-home-view')) { renderChats(); return; }
    const chat = current();
    if (!chat) { document.body.classList.remove('rc-chat-active'); active = ''; if (!routing) window.history.pushState({}, '', '/'); return; }
    if (room.isOpen()) document.body.classList.add('rc-chat-active');
    $('rcChatProvider').textContent = chat.provider === 'codex' ? 'Codex' : 'Claude';
    if (active !== chat.id) { active = chat.id; selectedFile = ''; selectedVersion = ''; files = []; loadFiles(); }
    renderChats(); renderUploads();
  }
  function newChat() {
    const d = dialog('New chat', `<form class="workspace-form"><label>Name<input name="name" placeholder="New chat" maxlength="300"></label><div class="rc-chat-form-grid"><label>Provider<select name="provider"><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>Account<select name="account"></select></label><label>Model<select name="model"></select></label><label>Effort<select name="effort"></select></label></div><p class="rc-chat-note">Automatic account selection keeps work moving across available accounts.</p><p role="alert"></p><button class="cr-primary">Create chat</button></form>`);
    const form = d.querySelector('form'), f = form.elements, requestId = crypto.randomUUID();
    function choices() {
      f.model.innerHTML = '<option value="">Provider default</option>' + engine.defaultModelOptions(f.provider.value).map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');
      f.account.innerHTML = '<option value="">Automatic</option>' + engine.state().accounts.filter(a => a.provider === f.provider.value).map(a => `<option value="${esc(a.name)}">${esc(a.label || a.displayName || a.name)}</option>`).join(''); efforts();
    }
    function efforts() { const m = engine.defaultModelOptions(f.provider.value).find(m => m.value === f.model.value); f.effort.innerHTML = (m?.efforts || [{ value:'', label:'Provider default' }]).map(e => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join(''); }
    f.provider.onchange = choices; f.model.onchange = efforts; choices();
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
      try { const chat = await request('/api/chats', { requestId, name:f.name.value || undefined, provider:f.provider.value, model:f.model.value, effort:f.effort.value, account:f.account.value || undefined }); await engine.reloadProjects(); await open(chat); d.close(); }
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
    engine.attachSaved(chatId, sessionId, { fileId:file.id, versionId:version.id, name:file.name, type:'application/octet-stream', url:`${base(chatId)}/files/${file.id}/versions/${version.id}/download` });
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
      return `<article class="rc-chat-file" data-file="${file.id}"><button data-preview><span class="rc-chat-file-icon">${esc(file.name.split('.').pop().slice(0,5).toUpperCase())}</span><strong>${esc(file.name)}</strong></button><small>v${file.versions.length} · ${Math.max(1,Math.round(v.bytes/1024))} KB · Saved</small><div><button data-attach>Attach</button><button data-download>Download</button><button data-history>Versions</button>${window.rcProjectSpaces?.enabled()&&current()?.spaceId?'<button data-share-project>Add to project</button>':''}<button data-remove>${file.removed ? 'Restore file' : 'Remove'}</button></div></article>`;
    }).join('') + (!visible.length ? '<div class="rc-chat-empty"><strong>Bring your work here</strong><p>Upload a proposal, PDF, or reference file. Saved versions stay with this chat across accounts.</p></div>' : '');
    $('rcChatRemoved').onclick=()=>{showRemoved=!showRemoved;renderPanel();};
    $('rcChatUploadButton').onclick = () => { const input = document.createElement('input'); input.type='file';input.multiple=true;input.onchange=()=>[...input.files].forEach(upload);input.click(); };
    $('rcChatPanelBody').querySelectorAll('[data-file]').forEach(row => {
      const file=files.find(f=>f.id===row.dataset.file),v=file.versions.find(v=>v.id===file.latestVersionId);
      row.querySelector('[data-preview]').onclick=()=>{selectedFile=file.id;selectedVersion=v.id;tab='preview';renderPanel();};
      row.querySelector('[data-download]').onclick=()=>download(file,v);
      row.querySelector('[data-attach]').onclick=()=>{attach(active,current().lastSessionId,file,v);notify('File attached.');};
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
    const id = typeof target === 'string' ? target : active, work=engine.state().projects.find(p=>p.id===id)?.kind!=='chat';
    const capabilitiesURL=(work?'/api/project-spaces/'+encodeURIComponent(id):base(id))+'/capabilities';
    const d = dialog('Tools', `<div class="rc-chat-tools"><div class="rc-tools-toolbar"><label>Account<select id="rcToolsAccount" disabled><option>Loading accounts…</option></select></label><input id="rcToolsSearch" type="search" placeholder="Search tools" aria-label="Search tools"></div><div class="rc-chat-tabs" role="group" aria-label="Tool category"><button data-kind="plugin" aria-pressed="true">Plugins <span></span></button><button data-kind="mcp" aria-pressed="false">MCP <span></span></button><button data-kind="skill" aria-pressed="false">Skills <span></span></button></div><p class="rc-tools-help">Required tools stay with this chat when you switch accounts.</p><div id="rcToolsList" aria-busy="true"><p class="rc-chat-empty" role="status">Checking available tools…</p></div><footer><span id="rcToolsRequired" role="status"></span><button class="cr-secondary" data-refresh>Refresh</button><button class="cr-secondary" data-manage>Manage connections</button></footer></div>`, 'rc-chat-tools-dialog');
    let kind = 'plugin', inventory, requirements = [], projectRequirements = [], saving = false;
    const accountSelect = d.querySelector('#rcToolsAccount'), list = d.querySelector('#rcToolsList'), search = d.querySelector('#rcToolsSearch');
    const accountLabel = name => { const a = engine.state().accounts.find(a => a.name === name); return a?.label || a?.displayName || name; };
    async function load(force = false) {
      const selected = accountSelect.value;
      d.querySelector('[data-refresh]').disabled = true; list.setAttribute('aria-busy', 'true');
      try {
        inventory = await request(capabilitiesURL + '?' + new URLSearchParams({sessionId:engine.state().sessionId,...(force?{refresh:'1'}:{})}));
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
            await request(capabilitiesURL, {requirements,...(work?{sessionId:engine.state().sessionId}:{})});
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
    const d = dialog('Reference a conversation', '<div class="rc-reference-picker"><input type="search" placeholder="Search projects and conversations" aria-label="Search references"><div class="rc-chat-reference-list"></div></div>', 'rc-chat-reference-dialog');
    function render() {
      const query = d.querySelector('input').value.trim().toLowerCase(), references = chat.references || [], host = d.querySelector('.rc-chat-reference-list');
      const sources = engine.state().projects.filter(p => p.id !== id), matching = p => (p.conversations || []).filter(c => (p.name + ' ' + c.title + ' ' + (window.rcProjectSpaces?.list()?.find(s=>s.id===window.rcProjectSpaces.scopeOf(p,c.sessionId))?.name||'')).toLowerCase().includes(query)).map(c => ({p,c}));
      const grouped = window.rcProjectSpaces?.enabled(), primary = window.rcProjectSpaces?.scopeOf;
      const spaceRows = grouped ? window.rcProjectSpaces.list().map(space=>({id:space.id,name:space.name,rows:sources.flatMap(matching).filter(({p,c})=>primary(p,c.sessionId)===space.id)})) : [];
      const groups = [...spaceRows,...sources.filter(p=>p.kind!=='chat').map(p=>({id:p.id,name:p.name,rows:matching(p).filter(({p,c})=>!grouped||!primary(p,c.sessionId))}))].sort((a,b)=>a.name.localeCompare(b.name));
      groups.push({id:'chats',name:grouped?'Standalone Chat':'Chats',rows:sources.filter(p=>p.kind==='chat').flatMap(matching).filter(({p,c})=>!grouped||!primary(p,c.sessionId))});
      host.innerHTML = groups.filter(g => g.rows.length).map(group => `<section class="rc-reference-group" data-project="${esc(group.id)}"><h3>${esc(group.name)}<span>${group.rows.length}</span></h3>${group.rows.map(({p,c}) => {
        const added = references.some(r => r.projectId === p.id && r.sessionId === c.sessionId);
        return `<button data-project-id="${esc(p.id)}" data-session-id="${esc(c.sessionId)}" ${added ? 'disabled' : ''}>${icon('chat')}<strong>${esc(c.title || 'Untitled conversation')}</strong><span>${added ? 'Added' : 'Add'}</span></button>`;
      }).join('')}</section>`).join('') || '<p class="rc-chat-empty" role="status">No conversations match your search.</p>';
      host.querySelectorAll('button:not(:disabled)').forEach(button => button.onclick = async () => {
        const next = [...references, {projectId:button.dataset.projectId, sessionId:button.dataset.sessionId}];
        host.querySelectorAll('button').forEach(b => b.disabled = true);
        try { await request(base(id) + '/references', {references:next}); await engine.reloadProjects(); d.close(); tab = 'references'; renderPanel(); document.body.classList.add('rc-chat-panel-open'); }
        catch (e) { notify(e); render(); }
      });
    }
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
  document.addEventListener('x056:state',sync);
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-chat-link]');
    if (!enabled || !link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(new URL(link.href).pathname);
  });
  window.addEventListener('popstate', () => { if (enabled) applyRoute(); });
  document.addEventListener('x056:reconnected',()=>{if(enabled)loadFiles();});
  document.addEventListener('x056:mode',event=>{if(event.detail.mode==='closed'){document.body.classList.remove('rc-chat-active','rc-chat-home-view');if(!routing&&inChat())window.history.pushState({},'', '/');}else setTimeout(sync,0);});
  document.addEventListener('x056:event',event=>{const {kind,data}=event.detail;if(kind==='chat_files'&&data.projectId===active)loadFiles();if(kind==='projects')engine.reloadProjects().then(sync);else if(kind==='conversation')setTimeout(sync,100);});
  return { navigate, leave, newChat, tools: toolsDialog, refresh: renderChats, init:async()=>{try{const data=await request('/api/chats');enabled=data.enabled;if(enabled){mount();if(inChat())await applyRoute();else sync();}}catch(error){if(inChat())notify(error);}}, upload, uploading:id=>[...jobs.values()].some(j=>j.chatId===id&&j.state==='uploading') };
};
