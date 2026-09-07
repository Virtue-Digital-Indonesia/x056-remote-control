/* Interactive account-management study. All accounts and usage below are sample data. */
(() => {
  if (document.body.dataset.concept !== 'control') return;
  const accounts = [
    {id:'g1',name:'ChatGPT · Primary',provider:'chatgpt',plan:'Personal',state:'ready',five:36,week:48,reset:'in 2h 18m',weeklyReset:'in 3 days'},
    {id:'g2',name:'ChatGPT · Backup',provider:'chatgpt',plan:'Personal',state:'ready',five:12,week:21,reset:'in 4h 05m',weeklyReset:'in 5 days'},
    {id:'c1',name:'Claude · Primary',provider:'claude',plan:'Personal',state:'ready',five:64,week:73,reset:'in 1h 42m',weeklyReset:'in 2 days'},
    {id:'c2',name:'Claude · Backup',provider:'claude',plan:'Personal',state:'limited',five:100,week:91,reset:'in 38m',weeklyReset:'in 4 days'}
  ];
  const next = {chatgpt:'g1',claude:'c1'};
  let provider='all',days=7,modalTrigger=null,selectedAccount=null,autoSwitch=true;
  const providerName=p=>p==='chatgpt'?'ChatGPT':'Claude';
  const compact=n=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(n);
  const number=n=>n.toLocaleString('en');
  const dayLabel=iso=>new Date(iso+'T00:00:00Z').toLocaleDateString('en',{month:'short',day:'numeric',timeZone:'UTC'});
  const records=[];
  for(let i=0;i<30;i++) accounts.forEach((account,a)=>{
    const date=new Date(Date.UTC(2026,7,9+i)).toISOString().slice(0,10);
    const turns=6+((i*7+a*11)%15)+(a===0?8:0);
    const failed=(i+a)%8===0?1:0;
    const main=Math.round(turns*.76);
    records.push({date,id:account.id,provider:account.provider,turns,failed,tokens:turns*(17000+a*2300)+(i%4)*750,models:account.provider==='chatgpt'?{'GPT-6':main,'GPT-5.6':turns-main}:{'Opus':main,'Sonnet':turns-main}});
  });
  const currentAccounts=()=>accounts.filter(a=>provider==='all'||a.provider===provider);
  const currentRecords=()=>records.filter(r=>(provider==='all'||r.provider===provider)&&r.date>=new Date(Date.UTC(2026,8,8-days)).toISOString().slice(0,10));
  const summarize=rows=>rows.reduce((s,r)=>{s.turns+=r.turns;s.failed+=r.failed;s.tokens+=r.tokens;Object.entries(r.models).forEach(([name,n])=>s.models[name]=(s.models[name]||0)+n);return s;},{turns:0,failed:0,tokens:0,models:{}});
  const root=document.createElement('main');root.id='accountsMain';root.className='accounts-main';root.hidden=true;
  root.innerHTML=`<header class="accounts-heading"><div><h1>Accounts</h1><p>Capacity, usage, and activity across your providers.</p></div><div class="heading-actions"><button class="outline accounts-mobile-nav" data-account-action="board" title="Back to Control room" aria-label="Back to Control room">${icon('grid')}</button><button class="outline" data-account-action="export" title="Export sample analytics" aria-label="Export sample analytics">${icon('file')}<span>Export</span></button><button class="primary" data-account-action="add" aria-label="Add account">${icon('plus')}<span>Add account</span></button></div></header>
    <div class="account-filters"><nav class="provider-filter" aria-label="Filter account provider"><button data-account-provider="all" class="active">All providers</button><button data-account-provider="chatgpt">ChatGPT</button><button data-account-provider="claude">Claude</button></nav><label class="date-filter"><select id="accountRange" aria-label="Analytics date range"><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label></div>
    <section class="account-kpis" aria-label="Usage overview" id="accountKpis"></section>
    <div class="account-charts"><section class="analytics-card"><header><h2>Turns over time</h2><small id="chartScale"></small></header><div class="chart-legend"><span><i></i>ChatGPT</span><span><i class="claude"></i>Claude</span></div><div class="activity-chart" id="accountChart" aria-label="Turns by date"></div><div class="chart-labels" id="chartLabels"></div><p class="chart-detail" id="chartDetail" aria-live="polite">Select a bar to inspect activity.</p></section><section class="analytics-card"><header><h2>Model usage</h2><small>Share of turns</small></header><div class="model-list" id="accountModels"></div><p class="model-note">Includes completed and failed turns in the selected period.</p></section></div>
    <div class="accounts-section-head"><h2>Connected accounts <span id="accountCount"></span></h2><span>Provider limits · current windows</span></div><div class="account-table-wrap"><table class="account-table"><thead><tr><th scope="col">Account</th><th scope="col">Status</th><th scope="col">5-hour usage</th><th scope="col">Weekly usage</th><th scope="col">Routing</th></tr></thead><tbody id="accountRows"></tbody></table></div>
    <section class="account-routing"><span class="icbtn" aria-hidden="true">${icon('branch')}</span><div class="routing-copy"><h3>Switch accounts automatically</h3><p>Use the next available account from the same provider when a limit is reached.</p></div><label class="account-switch"><input id="autoAccountSwitch" type="checkbox" checked aria-label="Switch accounts automatically"><span aria-hidden="true"></span></label></section><p class="account-footnote">Sample data through September 7. Account controls and exports apply only to this preview.</p>`;
  document.querySelector('.control .body').append(root);
  const modalVeil=document.createElement('div');modalVeil.id='accountModalVeil';modalVeil.className='account-modal-veil';modalVeil.hidden=true;
  modalVeil.innerHTML='<section class="account-modal" role="dialog" aria-modal="true" aria-labelledby="accountModalTitle"></section>';
  document.body.append(modalVeil);

  window.showControlSection=section=>{
    const isAccounts=section==='accounts';
    if(!document.getElementById('detailVeil').hidden)closeDetail();
    document.querySelector('.boardmain').hidden=isAccounts;
    root.hidden=!isAccounts;
    document.querySelector('.control-top > span').textContent=isAccounts?'Accounts':'Control room';
    document.querySelectorAll('.control-nav .navlink').forEach(b=>b.classList.toggle('active',isAccounts?b.dataset.action==='accounts':b.dataset.filter===filter));
    history.replaceState(null,'',location.pathname+(isAccounts?'#accounts':''));
  };
  window.openAccounts=()=>{showControlSection('accounts');render();};

  function quota(percent,reset,label,caption=''){return `<div class="quota-cell ${percent>=85?'high':''}">${caption?'<div class="quota-caption">'+caption+'</div>':''}<div class="quota-top"><span>${percent}% used</span></div><div class="quota-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div><div class="quota-reset">Resets ${reset}</div></div>`;}
  function render(){
    const rows=currentRecords(),visible=currentAccounts(),totals=summarize(rows),available=visible.filter(a=>a.state==='ready').length;
    const success=totals.turns?((totals.turns-totals.failed)/totals.turns*100).toFixed(1)+'%':'—';
    const kpis=[['Available accounts',available+' / '+visible.length,'Current availability'],['Turns',number(totals.turns),'Last '+days+' days'],['Tokens processed',compact(totals.tokens),'Input and output combined'],['Success rate',success,number(totals.failed)+' failed turns']];
    document.getElementById('accountKpis').innerHTML=kpis.map(([name,value,sub])=>`<article class="account-kpi"><div class="kpi-name">${name}</div><strong>${value}</strong><div class="kpi-sub">${sub}</div></article>`).join('');
    document.querySelectorAll('[data-account-provider]').forEach(b=>{b.classList.toggle('active',b.dataset.accountProvider===provider);b.setAttribute('aria-pressed',String(b.dataset.accountProvider===provider));});
    const buckets=[],step=days===30?5:1;
    for(let offset=0;offset<days;offset+=step){
      const start=new Date(Date.UTC(2026,8,8-days+offset)).toISOString().slice(0,10);
      const end=new Date(Date.UTC(2026,8,8-days+Math.min(offset+step,days)-1)).toISOString().slice(0,10);
      const rs=rows.filter(r=>r.date>=start&&r.date<=end);
      buckets.push({label:dayLabel(start),range:dayLabel(start)+(start!==end?' – '+dayLabel(end):''),chatgpt:rs.filter(r=>r.provider==='chatgpt').reduce((n,r)=>n+r.turns,0),claude:rs.filter(r=>r.provider==='claude').reduce((n,r)=>n+r.turns,0)});
    }
    const peak=Math.max(1,...buckets.map(b=>b.chatgpt+b.claude));
    document.getElementById('chartScale').textContent='Peak '+peak+' / '+(step===1?'day':'5 days');
    const chart=document.getElementById('accountChart');chart.replaceChildren();
    buckets.forEach(b=>{
      const total=b.chatgpt+b.claude,button=document.createElement('button');button.className='day-bar';
      const description=b.range+': '+total+' turns · ChatGPT '+b.chatgpt+' · Claude '+b.claude;
      button.title=description;button.setAttribute('aria-label',description);
      button.innerHTML=`<span class="bar-stack" style="height:${total/peak*95}%"><i class="claude" style="height:${total?b.claude/total*100:0}%"></i><i class="chatgpt" style="height:${total?b.chatgpt/total*100:0}%"></i></span>`;
      button.addEventListener('click',()=>{chart.querySelectorAll('button').forEach(el=>el.classList.toggle('selected',el===button));document.getElementById('chartDetail').textContent=description;});chart.append(button);
    });
    document.getElementById('chartLabels').innerHTML=buckets.map(b=>'<span>'+b.label+'</span>').join('');
    document.getElementById('chartDetail').textContent='Select a bar to inspect activity.';
    const models=Object.entries(totals.models).sort((a,b)=>b[1]-a[1]);
    document.getElementById('accountModels').innerHTML=models.length?models.map(([name,count])=>`<div class="model-row"><div class="row"><span>${name}</span><small>${number(count)} turns · ${Math.round(count/totals.turns*100)}%</small></div><div class="model-meter"><i style="width:${count/totals.turns*100}%"></i></div></div>`).join(''):'<p class="account-empty">No activity in this period.</p>';
    document.getElementById('accountCount').textContent='('+visible.length+')';
    document.getElementById('accountRows').innerHTML=visible.map(a=>`<tr><td><div class="account-identity"><span class="provider-mark">${a.provider==='chatgpt'?'G':'C'}</span><div><span class="account-name">${escapeHTML(a.name)}</span><div class="account-meta">${providerName(a.provider)} · ${a.plan}</div></div></div></td><td><span class="account-state ${a.state}"><i class="status"></i>${a.state==='ready'?'Available':a.state==='limited'?'At limit':'Paused'}</span></td><td data-label="5-hour usage">${quota(a.five,a.reset,'5-hour usage for '+escapeHTML(a.name))}</td><td data-label="Weekly usage">${quota(a.week,a.weeklyReset,'Weekly usage for '+escapeHTML(a.name))}</td><td><div class="account-actions"><button class="next-account ${next[a.provider]===a.id?'selected':''}" data-account-next="${a.id}" ${a.state!=='ready'?'disabled':''}>${next[a.provider]===a.id?'Next up':'Use next'}</button><button class="icbtn" data-account-details="${a.id}" title="Manage ${escapeHTML(a.name)}" aria-label="Manage ${escapeHTML(a.name)}">${icon('more')}</button></div></td></tr>`).join('');
    document.getElementById('autoAccountSwitch').checked=autoSwitch;
  }
  function openModal(html){
    modalTrigger=document.activeElement;
    modalVeil.querySelector('.account-modal').innerHTML=html;
    modalVeil.hidden=false;document.querySelector('.app').inert=true;document.querySelector('.studybar').inert=true;
    modalVeil.querySelector('input,button,select')?.focus();
  }
  function closeModal(){modalVeil.hidden=true;document.querySelector('.app').inert=false;document.querySelector('.studybar').inert=false;if(modalTrigger?.isConnected)modalTrigger.focus();else root.querySelector('[data-account-action="add"]').focus();}
  function modalHeader(title){return `<header class="row between"><h2 id="accountModalTitle">${escapeHTML(title)}</h2><button class="icbtn" data-account-action="close" aria-label="Close account details">${icon('close')}</button></header>`;}
  function showDetails(id){
    const a=accounts.find(a=>a.id===id);selectedAccount=a;
    const totals=summarize(currentRecords().filter(r=>r.id===id));
    openModal(`${modalHeader(a.name)}<p class="sub">${providerName(a.provider)} · ${a.plan} · Sample account</p><div class="account-status-line">${a.state==='limited'?'At the 5-hour limit. Resets '+a.reset+'.':a.state==='paused'?'Paused. Excluded from automatic account selection.':next[a.provider]===id?'Selected for the next '+providerName(a.provider)+' turn.':'Available for new turns and automatic switching.'}</div><div class="quota-pair">${quota(a.five,a.reset,'5-hour usage','5-hour usage')}${quota(a.week,a.weeklyReset,'Weekly usage','Weekly usage')}</div><div class="account-detail-stats"><div><small>Turns · last ${days} days</small><strong>${number(totals.turns)}</strong></div><div><small>Tokens processed</small><strong>${compact(totals.tokens)}</strong></div></div><div class="account-models">${Object.entries(totals.models).map(([name,count])=>`<div class="row between"><span>${name}</span><span class="muted">${count} turns</span></div>`).join('')||'<p class="muted">No activity recorded for this sample account.</p>'}</div><div class="modal-actions"><button class="outline" data-account-action="pause">${a.state==='paused'?'Resume account':'Pause account'}</button><button class="primary" data-account-action="close">Done</button></div>`);
  }
  function showAdd(){openModal(`${modalHeader('Add account')}<p class="sub">Add a sample account to explore the dashboard.</p><form id="addSampleAccount"><label class="field">Provider<select name="provider"><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select></label><label class="field">Account name<input name="name" placeholder="e.g. Team account" maxlength="50" required></label><div class="modal-actions"><button class="outline" type="button" data-account-action="close">Cancel</button><button class="primary" type="submit">Add sample account</button></div></form>`);modalVeil.querySelector('input').focus();}
  function exportUsage(){
    const csvCell=v=>'"'+String(v).replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
    const lines=[['Date','Account','Provider','Turns','Failed turns','Tokens']];
    currentRecords().forEach(r=>lines.push([r.date,accounts.find(a=>a.id===r.id).name,providerName(r.provider),r.turns,r.failed,r.tokens]));
    const blob=new Blob([lines.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='x056-sample-usage-'+days+'d.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Sample analytics exported');
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.dataset.accountProvider){provider=button.dataset.accountProvider;render();}
    if(button.dataset.accountNext){const a=accounts.find(a=>a.id===button.dataset.accountNext);if(a.state==='ready'){next[a.provider]=a.id;render();toast(a.name+' will be used next in this preview');}}
    if(button.dataset.accountDetails)showDetails(button.dataset.accountDetails);
    const action=button.dataset.accountAction;
    if(action==='board')showControlSection('board');if(action==='export')exportUsage();if(action==='add')showAdd();if(action==='close')closeModal();
    if(action==='pause'){
      const a=selectedAccount;a.state=a.state==='paused'?(a.five>=100?'limited':'ready'):'paused';
      if(a.state!=='ready'&&next[a.provider]===a.id)next[a.provider]=accounts.find(other=>other.provider===a.provider&&other.state==='ready')?.id;
      if(a.state==='ready'&&!next[a.provider])next[a.provider]=a.id;
      closeModal();render();toast(a.name+(a.state==='paused'?' paused in this preview':' resumed in this preview'));
    }
  });
  modalVeil.addEventListener('click',e=>{if(e.target===modalVeil)closeModal();});
  document.addEventListener('keydown',e=>{if(!modalVeil.hidden&&e.key==='Escape'){e.stopImmediatePropagation();e.preventDefault();closeModal();}else if(!modalVeil.hidden&&(e.ctrlKey||e.metaKey)&&e.key==='k'){e.stopImmediatePropagation();e.preventDefault();}},true);
  document.getElementById('accountRange').addEventListener('change',e=>{days=Number(e.target.value);render();});
  document.getElementById('autoAccountSwitch').addEventListener('change',e=>{autoSwitch=e.target.checked;toast(autoSwitch?'Automatic switching enabled in this preview':'Automatic switching paused in this preview');});
  modalVeil.addEventListener('submit',e=>{
    if(e.target.id!=='addSampleAccount')return;e.preventDefault();
    const form=new FormData(e.target),name=String(form.get('name')||'').trim();if(!name)return;
    const p=form.get('provider')==='claude'?'claude':'chatgpt';
    accounts.push({id:'sample-'+Date.now(),name,provider:p,plan:'Personal',state:'ready',five:0,week:0,reset:'in 5h',weeklyReset:'in 7 days'});
    if(!next[p])next[p]=accounts.at(-1).id;provider='all';closeModal();render();toast('Sample account added');
  });
  render();
  if(document.body.dataset.initialSection==='accounts'||location.hash==='#accounts')openAccounts();
})();
