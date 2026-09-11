/* Free-form Chat uses the existing conversation engine and its delivery ledger. */
window.createRCChat = function (engine, room) {
  'use strict';
  const $ = id => document.getElementById(id), esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  let enabled = false, mounted = false, active = '', selectedFile = '', selectedVersion = '', tab = 'files', files = [], sequence = 0, previewTimer, objectURLs = [], showArchived = false, showRemoved = false;
  const jobs = new Map();
  const current = () => engine.state().projects.find(p => p.id === engine.state().projectId && p.kind === 'chat');
  const request = async (url, body) => { const response = await engine.api(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Request failed'); return data; };
  const base = id => '/api/chats/' + encodeURIComponent(id);
  const versionURL = (file, version) => `${base(active)}/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(version.id)}`;
  function dialog(title, body) {
    const d = document.createElement('dialog'); d.className = 'cr-dialog rc-chat-dialog';
    d.innerHTML = `<header><h2>${esc(title)}</h2><button type="button" aria-label="Close">×</button></header>${body}`;
    d.querySelector('header button').onclick = () => d.close(); d.onclose = () => d.remove(); document.body.append(d); d.showModal(); return d;
  }
  function notify(error) { room.notify(error instanceof Error ? error.message : error); }
  function mount() {
    if (mounted) return; mounted = true;
    const button = document.createElement('button'); button.id = 'crChatTab'; button.textContent = 'Chat'; $('crBoardTab').after(button); button.onclick = enter;
    const nav = document.createElement('aside'); nav.id = 'rcChatNav'; nav.setAttribute('aria-label','Chats');
    nav.innerHTML = `<button class="rc-chat-home" id="rcChatHome">x0 <span>Remote Control</span></button><button class="cr-primary" id="rcChatNew">+ New chat</button><input id="rcChatSearch" type="search" placeholder="Search chats" aria-label="Search chats"><div class="rc-chat-list" id="rcChatList"></div><button class="cr-secondary" id="rcChatArchives">Archived chats</button><button class="cr-secondary" id="rcChatAccounts">Accounts</button><button class="cr-secondary" id="rcChatControl">Control room</button>`;
    $('conversationSurface').prepend(nav);
    const panel = document.createElement('aside'); panel.id = 'rcChatInspector'; panel.setAttribute('aria-label', 'Chat files and references');
    panel.innerHTML = `<header><strong>Workspace</strong><button class="cr-icon" id="rcChatPanelClose" aria-label="Close file panel">×</button></header><div class="rc-chat-tabs"><button data-chat-tab="files" aria-pressed="true">Files</button><button data-chat-tab="preview">Preview</button><button data-chat-tab="references">References</button></div><div id="rcChatUploads" role="status"></div><div id="rcChatPanelBody"></div>`;
    $('conversationSurface').append(panel);
    const tools = document.createElement('div'); tools.id = 'rcChatControls';
    tools.innerHTML = `<button class="cr-secondary" id="rcChatMenu">Chats</button><span id="rcChatProvider"></span><button class="cr-secondary" id="rcChatTools">Tools</button><button class="cr-secondary" id="rcChatReference">@ Reference</button><button class="cr-secondary" id="rcChatFiles">Files</button><button class="cr-icon" id="rcChatMore" aria-label="Chat actions">•••</button>`;
    document.querySelector('.composer-wrap').prepend(tools);
    $('rcChatNew').onclick = newChat; $('rcChatHome').onclick = $('rcChatControl').onclick = leave;
    $('rcChatAccounts').onclick = () => { leave(); room.showAccounts(); };
    $('rcChatSearch').oninput = renderChats;
    $('rcChatArchives').onclick = () => { showArchived = !showArchived; $('rcChatArchives').textContent = showArchived ? 'Active chats' : 'Archived chats'; renderChats(); };
    $('rcChatMenu').onclick = () => document.body.classList.toggle('rc-chat-nav-open');
    $('rcChatFiles').onclick = () => { document.body.classList.add('rc-chat-panel-open'); tab = 'files'; renderPanel(); };
    $('rcChatPanelClose').onclick = () => document.body.classList.remove('rc-chat-panel-open');
    $('rcChatTools').onclick = toolsDialog; $('rcChatReference').onclick = referencePicker; $('rcChatMore').onclick = chatActions;
    panel.querySelectorAll('[data-chat-tab]').forEach(button => button.onclick = () => { tab = button.dataset.chatTab; renderPanel(); });
  }
  async function enter() {
    await engine.reloadProjects();
    const chat = current() || engine.state().projects.find(p => p.kind === 'chat' && !p.archivedAt);
    if (chat) await open(chat); else newChat();
  }
  async function open(chat) {
    try {
      await engine.select(chat.id, chat.lastSessionId); document.body.classList.add('rc-chat-active');
      room.openChat(); sync(); document.body.classList.remove('rc-chat-nav-open');
    } catch (error) { notify(error); }
  }
  function leave() { document.body.classList.remove('rc-chat-active','rc-chat-nav-open','rc-chat-panel-open'); room.closeChat(); }
  function renderChats() {
    const query = $('rcChatSearch').value.toLowerCase(), state = engine.state();
    const chats = state.projects.filter(p => p.kind === 'chat' && !!p.archivedAt === showArchived && (p.name + ' ' + p.conversations?.[0]?.title).toLowerCase().includes(query));
    chats.sort((a,b) => (b.conversations?.[0]?.lastMessageAt || b.conversations?.[0]?.createdAt || 0) - (a.conversations?.[0]?.lastMessageAt || a.conversations?.[0]?.createdAt || 0));
    $('rcChatList').innerHTML = chats.map(p => `<button class="rc-chat-item ${p.id === active ? 'selected' : ''}" data-chat="${esc(p.id)}"><strong>${esc(p.conversations?.[0]?.title || p.name)}</strong><small>${esc(p.provider === 'codex' ? 'Codex' : 'Claude')}${p.running ? ' · Working' : ''}</small></button>`).join('') || '<p class="rc-chat-empty">No chats yet.</p>';
    $('rcChatList').querySelectorAll('[data-chat]').forEach(button => button.onclick = () => open(chats.find(p => p.id === button.dataset.chat)));
  }
  function sync() {
    if (!mounted) return;
    const chat = current();
    if (!chat) { document.body.classList.remove('rc-chat-active'); active = ''; return; }
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
    const d = dialog('Chat actions', `<div class="workspace-form"><button data-rename>Rename</button><button data-archive>${chat.archivedAt ? 'Restore' : 'Archive'}</button><button data-controls>Conversation controls</button></div>`);
    d.querySelector('[data-controls]').onclick = () => { d.close(); room.conversationMenu($('rcChatMore')); };
    d.querySelector('[data-rename]').onclick = async () => { d.close(); const name = await engine.prompt({ title:'Rename chat', value:chat.conversations?.[0]?.title || chat.name }); if (name) try { await request(base(chat.id), { name }); await engine.reloadProjects(); sync(); } catch (e) { notify(e); } };
    d.querySelector('[data-archive]').onclick = async () => { try { await request(base(chat.id), { archived:!chat.archivedAt }); d.close(); await engine.reloadProjects(); sync(); if (!chat.archivedAt) leave(); } catch (e) { notify(e); } };
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
      return `<article class="rc-chat-file" data-file="${file.id}"><button data-preview><span class="rc-chat-file-icon">${esc(file.name.split('.').pop().slice(0,5).toUpperCase())}</span><strong>${esc(file.name)}</strong></button><small>v${file.versions.length} · ${Math.max(1,Math.round(v.bytes/1024))} KB · Saved</small><div><button data-attach>Attach</button><button data-download>Download</button><button data-history>Versions</button><button data-remove>${file.removed ? 'Restore file' : 'Remove'}</button></div></article>`;
    }).join('') + (!visible.length ? '<div class="rc-chat-empty"><strong>Bring your work here</strong><p>Upload a proposal, PDF, or reference file. Saved versions stay with this chat across accounts.</p></div>' : '');
    $('rcChatRemoved').onclick=()=>{showRemoved=!showRemoved;renderPanel();};
    $('rcChatUploadButton').onclick = () => { const input = document.createElement('input'); input.type='file';input.multiple=true;input.onchange=()=>[...input.files].forEach(upload);input.click(); };
    $('rcChatPanelBody').querySelectorAll('[data-file]').forEach(row => {
      const file=files.find(f=>f.id===row.dataset.file),v=file.versions.find(v=>v.id===file.latestVersionId);
      row.querySelector('[data-preview]').onclick=()=>{selectedFile=file.id;selectedVersion=v.id;tab='preview';renderPanel();};
      row.querySelector('[data-download]').onclick=()=>download(file,v);
      row.querySelector('[data-attach]').onclick=()=>{attach(active,current().lastSessionId,file,v);notify('File attached.');};
      row.querySelector('[data-history]').onclick=()=>history(file);
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
  async function toolsDialog() {
    const id=active,d=dialog('Tools',`<div class="rc-chat-tools"><div class="rc-chat-tabs"><button data-kind="plugin">Plugins</button><button data-kind="mcp">MCP</button><button data-kind="skill">Skills</button></div><label>Account<select id="rcToolsAccount"></select></label><input id="rcToolsSearch" type="search" placeholder="Search tools" aria-label="Search tools"><div id="rcToolsList" role="status">Checking available tools…</div><footer><button data-refresh>Refresh</button><button data-manage>Manage connections</button></footer></div>`);let kind='plugin',inventory,requirements=[];
    async function load(force=false){try{inventory=await request(base(id)+'/capabilities'+(force?'?refresh=1':''));if(!d.open)return;requirements=inventory.requirements;$('rcToolsAccount').innerHTML=inventory.accounts.map(a=>`<option value="${esc(a.account)}">${esc(a.account)}</option>`).join('');const s=engine.state();$('rcToolsAccount').value=s.composerAccount||s.runningAccount||inventory.accounts[0]?.account||'';render();}catch(e){if(d.open)$('rcToolsList').textContent=e.message;}}
    function render(){const account=inventory?.accounts.find(a=>a.account===$('rcToolsAccount').value),query=$('rcToolsSearch').value.toLowerCase();$('rcToolsList').innerHTML=(account?.errors||[]).map(e=>`<p>${esc(e)}</p>`).join('')+(account?.capabilities||[]).filter(c=>c.kind===kind&&c.name.toLowerCase().includes(query)).map(c=>`<article class="rc-chat-capability" data-key="${esc(c.key)}"><strong>${esc(c.name)}</strong><small>${esc(c.state.replaceAll('-',' '))}${requirements.some(r=>r.key===c.key&&r.fingerprint&&r.fingerprint!==c.fingerprint)?' · Account version differs':''}</small><p>${esc(c.description||'')}</p><label><input type="checkbox" ${requirements.some(r=>r.key===c.key)?'checked':''}>Required for this task</label>${c.invocation?'<button data-invoke '+(c.state==='ready'?'':'disabled')+'>Use skill</button>':''}</article>`).join('');if(!$('rcToolsList').textContent.trim())$('rcToolsList').textContent='No tools available in this category.';
      $('rcToolsList').querySelectorAll('[data-key]').forEach(row=>{const c=account.capabilities.find(c=>c.key===row.dataset.key);row.querySelector('input').onchange=async event=>{const before=requirements;requirements=requirements.filter(r=>r.key!==c.key);if(event.target.checked)requirements.push({key:c.key,fingerprint:c.fingerprint});try{await request(base(id)+'/capabilities',{requirements});}catch(e){requirements=before;notify(e);render();}};const use=row.querySelector('[data-invoke]');if(use)use.onclick=async()=>{try{if(!requirements.some(r=>r.key===c.key)){requirements.push({key:c.key,fingerprint:c.fingerprint});await request(base(id)+'/capabilities',{requirements});}engine.insertPrompt(c.invocation+' ');d.close();}catch(e){notify(e);}};});}
    d.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{kind=b.dataset.kind;render();});$('rcToolsAccount').onchange=render;$('rcToolsSearch').oninput=render;d.querySelector('[data-refresh]').onclick=()=>load(true);d.querySelector('[data-manage]').onclick=()=>{d.close();room.showSettings('connections');};load();
  }
  function referencePicker() {
    const id=active,chat=current(),d=dialog('Reference a conversation','<div class="workspace-form"><input type="search" placeholder="Search projects and conversations" aria-label="Search references"><div class="rc-chat-reference-list"></div></div>');
    function render(){const query=d.querySelector('input').value.toLowerCase(),rows=engine.state().projects.filter(p=>p.id!==id).flatMap(p=>(p.conversations||[]).map(c=>({p,c}))).filter(({p,c})=>(p.name+' '+c.title).toLowerCase().includes(query));const host=d.querySelector('.rc-chat-reference-list');host.innerHTML=rows.map(({p,c},i)=>`<button data-index="${i}"><strong>${esc(c.title)}</strong><small>${esc(p.name)}</small></button>`).join('');host.querySelectorAll('button').forEach(button=>button.onclick=async()=>{const {p,c}=rows[Number(button.dataset.index)],references=chat.references||[];if(!references.some(r=>r.projectId===p.id&&r.sessionId===c.sessionId))references.push({projectId:p.id,sessionId:c.sessionId});try{await request(base(id)+'/references',{references});await engine.reloadProjects();d.close();tab='references';renderPanel();document.body.classList.add('rc-chat-panel-open');}catch(e){notify(e);}});}
    d.querySelector('input').oninput=render;render();
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
  document.addEventListener('x056:reconnected',()=>{if(enabled)loadFiles();});
  document.addEventListener('x056:mode',event=>{if(event.detail.mode==='closed')document.body.classList.remove('rc-chat-active');else setTimeout(sync,0);});
  document.addEventListener('x056:event',event=>{const {kind,data}=event.detail;if(kind==='chat_files'&&data.projectId===active)loadFiles();if(kind==='projects')engine.reloadProjects().then(sync);else if(kind==='conversation')setTimeout(sync,100);});
  return { init:async()=>{try{const data=await request('/api/chats');enabled=data.enabled;if(enabled){mount();sync();}}catch{}}, upload, uploading:id=>[...jobs.values()].some(j=>j.chatId===id&&j.state==='uploading') };
};
