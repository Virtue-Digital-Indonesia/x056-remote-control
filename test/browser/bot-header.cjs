/* The Bot chat's own header: the tidied button row, the status line, "Needs you", the Today popover, Bot settings,
 * the Brief me now states, the quick-action row, a 390px phone, reduced motion, and that an ordinary chat keeps its header.
 * Isolated gateway only. /api/bot* and /api/bot/overview are mocked, and the Bot flag is added to a real chat row.
 * Run the fixture with X056_CHAT_ENABLED=1 X056_PROJECT_SPACES_ENABLED=1. */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:4391',token='browser-fixture-token-0123456789';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use the isolated localhost fixture');
const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+.05)/(y+.05);};
const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const errors=[],checks=[];
  const check=(name,value)=>{assert(value,name);checks.push(name);};
  const newContext=async opts=>{const c=await browser.newContext({viewport:{width:1280,height:860},...opts});await c.addInitScript(t=>localStorage.setItem('x056_token',t),token);return c;};
  const context=await newContext();
  const api=async(path,data)=>{const r=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const botChat=await api('/api/chats',{requestId:randomUUID(),name:'Assistant',provider:'claude'});
  const other=await api('/api/chats',{requestId:randomUUID(),name:'Ordinary chat',provider:'claude'});
  const botUrl='/chat/'+encodeURIComponent(botChat.id),otherUrl='/chat/'+encodeURIComponent(other.id);
  const tz='Asia/Jakarta',today=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  let botState,overview,briefMode,briefHold,overviewCalls,posted;
  const reset=()=>{botState={enabled:true,projectId:botChat.id,sessionId:botChat.lastSessionId,briefAt:'07:30',tz,lastBriefDate:null,url:botUrl};overview={running:[],needsYou:[],delegates:[],recent:[],scheduled:[],accounts:[]};briefMode='ok';briefHold=0;overviewCalls=0;posted=[];};
  reset();
  const route=async ctx=>{
   await ctx.route('**/api/bot',async r=>{const req=r.request();
    if(req.method()==='POST'){const body=req.postDataJSON();posted.push(body);
     if(body.briefAt&&body.briefAt>='12:00')return r.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'The morning brief must be before 12:00'})});
     botState={...botState,...body};botState.url=botState.enabled?botUrl:null;}
    await r.fulfill({contentType:'application/json',body:JSON.stringify(botState)});});
   await ctx.route('**/api/bot/brief',async r=>{if(briefHold)await new Promise(res=>setTimeout(res,briefHold));
    if(briefMode==='fail')return r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({message:'A brief is already running'})});
    await r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,queued:true})});});
   await ctx.route('**/api/bot/overview*',async r=>{overviewCalls++;await r.fulfill({contentType:'application/json',body:JSON.stringify(overview)});});
   await ctx.route(/\/api\/projects(\?|$)/,async r=>{const response=await r.fetch(),data=await response.json();for(const p of data.projects||data.chats||[])if(p.id===botChat.id&&botState.enabled)p.bot=true;await r.fulfill({response,json:data});});
  };
  await route(context);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack));
  const go=async path=>{await page.goto(base+path);await page.waitForTimeout(1100);};
  const vis=sel=>page.locator(sel).first().isVisible();

  // 1. Ordinary chat first: its header is untouched and the Bot's is absent.
  await go(otherUrl);
  for(const id of ['chatActivity','chatRefresh','autopilotBtn','chatClose','chatResults','chatTerminal','chatAgentTree','moreBtn'])check('an ordinary chat still shows #'+id,await vis('#'+id));
  check('an ordinary chat has no Bot header',await page.locator('#rcBotHead').isHidden());
  check('an ordinary chat has no Bot aurora',await page.evaluate(()=>getComputedStyle(document.querySelector('.focus-main'),'::before').animationName==='none'));
  check('an ordinary chat shows its own title block',await vis('.focus-main>.topbar .project-heading'));
  check('an ordinary chat has no quick actions',await page.locator('#rcBotQuick').isHidden());

  // 2. The Bot chat: the buttons that are gone, the ones kept, the ones added.
  await go(botUrl);
  await page.locator('#rcBotHead').waitFor({state:'visible',timeout:5000});
  for(const id of ['chatActivity','chatRefresh','autopilotBtn','chatClose','chatResults'])check('the Bot chat hides #'+id,await page.locator('#'+id).isHidden());
  check('#autopilotBtn, #chatActivity and #chatClose stay in the DOM',await page.locator('#autopilotBtn,#chatActivity,#chatClose').count()===3);
  for(const id of ['chatTerminal','chatAgentTree','moreBtn','rcBotBriefNow','rcBotToday','rcBotSettings'])check('the Bot chat shows #'+id,await vis('#'+id));
  check('#projTitle stays in the DOM, its block hidden',await page.locator('#projTitle').count()===1&&await page.locator('#projTitle').isHidden());
  check('the header orb is a 36px orb',await page.locator('#rcBotHead .bot-orb').evaluate(o=>o.offsetWidth===36));
  check('the name still reads Bot',await page.locator('#rcBotHead .rc-bot-badge').innerText()==='Bot');
  check('the status reads Idle',await page.locator('#rcBotStatus').innerText()==='Idle');
  check('the next brief is today at 07:30',await page.locator('#rcBotBriefAt').innerText()==='Next brief 07:30');
  check('the overview was fetched once on open',overviewCalls===1);
  check('no Needs you chip when nothing needs you',await page.locator('#rcBotNeeds').isHidden());
  check('the aurora backs the whole Bot chat',await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('.focus-main'),'::before');return s.animationName==='bot-drift'&&s.pointerEvents==='none'&&!/blur/.test(s.filter+s.backdropFilter);}));
  check('the hero keeps one aurora only',await page.locator('#rcBotHero .bot-aurora').evaluate(a=>getComputedStyle(a).display==='none'));
  await page.screenshot({path:'/tmp/bot-visuals2/test-empty.png'});

  // 3. Brief me now: name, states, error chip.
  const brief=page.locator('#rcBotBriefNow');
  check('Brief me now has a steady accessible name',await page.getByRole('button',{name:'Brief me now'}).count()>=2);
  check('Brief me now carries a sun icon',await brief.locator('svg.rb-ic').isVisible());
  briefHold=600;await brief.click();
  check('Brief me now is busy while pending',await brief.getAttribute('data-state')==='busy'&&await brief.getAttribute('aria-busy')==='true'&&await brief.isDisabled());
  check('the busy label says Requesting',(await brief.innerText()).trim()==='Requesting…');
  check('the busy state shows a spinner, not the sun',await brief.locator('.rb-spin').isVisible()&&await brief.locator('svg.rb-ic').isHidden());
  await page.waitForFunction(()=>document.getElementById('rcBotBriefNow').dataset.state==='done',null,{timeout:4000});
  check('success reads Brief requested with a check',(await brief.innerText()).trim()==='Brief requested'&&await brief.locator('svg.rb-ck').isVisible()&&!await brief.isDisabled());
  check('the orb hops for joy',await page.locator('#rcBotHead .bot-orb.happy').count()===1);
  await page.waitForFunction(()=>document.getElementById('rcBotBriefNow').dataset.state==='idle',null,{timeout:4000});
  check('success settles back to Brief me now',(await brief.innerText()).trim()==='Brief me now');
  briefHold=0;briefMode='fail';await brief.click();
  await page.locator('#rcBotBriefStatus.error').waitFor({state:'visible',timeout:4000});
  check('an error shows as a readable chip',/already running/.test(await page.locator('#rcBotBriefStatus').innerText())&&await brief.getAttribute('data-state')==='idle');
  const errColors=await page.locator('#rcBotBriefStatus').evaluate(e=>{const s=getComputedStyle(e);return [s.color,s.backgroundColor,getComputedStyle(document.body).backgroundColor];});
  const [er,eg]=[rgb(errColors[0]),rgb(errColors[1])],pageBg=rgb(errColors[2]);
  check('the error chip text passes 4.5:1',ratio(er,pageBg.map((v,i)=>v*.89+[229,72,77][i]*.11))>=4.5);
  briefMode='ok';
  // Contrast of the Brief label on both tints, light theme.
  const [txt,bg0]=await brief.evaluate(b=>[getComputedStyle(b).color,getComputedStyle(document.body).backgroundColor]);
  const tc=rgb(txt),bc=rgb(bg0),mix=(c,k)=>bc.map((v,i)=>v*(1-k)+c[i]*k);
  check('the Brief label passes 4.5:1 on its tint (light)',Math.min(ratio(tc,mix([76,141,255],.09)),ratio(tc,mix([255,181,154],.11)))>=4.5);

  // 4. Today popover and Needs you.
  await page.locator('#rcBotToday').click();
  const pop=page.locator('#rcBotTodayPop');await pop.waitFor({timeout:3000});
  check('Today with nothing pending says so',/Nothing needs you/.test(await pop.innerText())&&await pop.locator('.bot-orb.happy').count()===1);
  check('Today names the next brief',/Next brief 07:30/.test(await pop.innerText()));
  await page.keyboard.press('Escape');
  check('Escape closes Today and returns focus to its button',await pop.count()===0&&await page.evaluate(()=>document.activeElement.id==='rcBotToday'));
  overview={running:[{projectName:'Billing',title:'Refactor invoices',state:'turn',since:new Date(Date.now()-300000).toISOString(),sessionId:'s1'},{projectName:'Bot',title:'Assistant',state:'turn',since:null,sessionId:botState.sessionId}],
   needsYou:[{kind:'question',projectName:'x056',title:'Deploy x056',text:'Swap the gateway now?'},{kind:'approval',projectName:'Chat',title:'Assistant',text:'Send "run the migration"'}],
   delegates:[{role:'reviewer',status:'working',working:true,orchestratorTitle:'Refactor invoices'}],recent:[],
   scheduled:[{label:'Nightly backup',schedule:'0 3 * * *',lastResult:'failed: disk full',lastRunAt:new Date(Date.now()-7200000).toISOString()},{label:'Ping',schedule:'* * * * *',lastResult:'delivered'}],accounts:[]};
  await page.reload();await page.waitForTimeout(1300);
  const needs=page.locator('#rcBotNeeds');await needs.waitFor({state:'visible',timeout:4000});
  check('the Needs you chip counts 2',(await needs.innerText()).replace(/\s+/g,' ').trim()==='2 need you'&&/2 things need you/.test(await needs.getAttribute('aria-label')));
  await needs.click();await pop.waitFor({timeout:3000});
  const text=await pop.innerText();
  check('Today lists the two things that need you',/Deploy x056/.test(text)&&/Swap the gateway now\?/.test(text)&&/Approval/.test(text)&&/run the migration/.test(text));
  check('Today lists what is running without the Bot itself',/Refactor invoices/.test(text)&&!/RUNNING\s*\n?\s*2/.test(text)&&/RUNNING\s*1/i.test(text.replace(/\n/g,' ')));
  check('Today lists delegates and only the failed schedule',/reviewer/.test(text)&&/Nightly backup/.test(text)&&!/Ping/.test(text));
  check('the popover is inside the viewport',await pop.evaluate(p=>{const r=p.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  await page.screenshot({path:'/tmp/bot-visuals2/test-today.png'});
  await page.mouse.click(700,500);
  check('a click outside closes Today',await pop.count()===0);

  // 5. Bot settings: save, the server message, and the switch.
  await page.locator('#rcBotSettings').click();
  const dlg=page.locator('dialog.rc-bot-settings');await dlg.waitFor({timeout:3000});
  check('settings shows the orb hero, the time and the zone',await dlg.locator('.bot-orb').evaluate(o=>o.offsetWidth===72)&&await dlg.locator('.bot-aurora').count()===1&&await dlg.locator('input[type=time]').inputValue()==='07:30'&&/Asia\/Jakarta time/.test(await dlg.innerText()));
  await dlg.locator('input[type=time]').fill('13:00');await dlg.getByRole('button',{name:'Save'}).click();
  await page.waitForFunction(()=>/before 12:00/.test(document.querySelector('dialog.rc-bot-settings [role=alert]').textContent),null,{timeout:3000});
  check('a rejected time shows the server message inline',await dlg.isVisible()&&posted.at(-1).briefAt==='13:00');
  await dlg.locator('input[type=time]').fill('06:15');await dlg.getByRole('button',{name:'Save'}).click();
  await dlg.waitFor({state:'detached',timeout:4000});
  check('Save posts briefAt and the header follows',posted.at(-1).briefAt==='06:15'&&await page.locator('#rcBotBriefAt').innerText()==='Next brief 06:15');
  await page.locator('#rcBotSettings').click();await dlg.waitFor({timeout:3000});
  await page.screenshot({path:'/tmp/bot-visuals2/test-settings.png'});
  const toggle=dlg.getByRole('button',{name:'Turn Bot off'});await toggle.click();
  check('turning off asks for a second tap',posted.at(-1).enabled===undefined&&await dlg.getByRole('button',{name:'Tap again to turn off'}).isVisible());
  await dlg.getByRole('button',{name:'Tap again to turn off'}).click();
  await page.waitForURL(u=>new URL(u).pathname==='/bot',{timeout:6000});
  check('turn off posts enabled:false',posted.at(-1).enabled===false);
  await page.locator('#rcBotSetup').getByRole('heading',{name:'Set up your Bot'}).waitFor({timeout:4000});
  check('after turning off, /bot shows the setup card',true);
  check('the Bot header is gone',await page.locator('#rcBotHead').isHidden());
  await page.locator('#rcBotSetup').getByRole('button',{name:'Enable Bot'}).click();
  await page.waitForURL(u=>new URL(u).pathname===botUrl,{timeout:6000});
  check('Enable brings the Bot back',posted.at(-1).enabled===true);

  // 6. Status and quick actions through a real turn.
  reset();await go(botUrl);
  const prompt=page.locator('#prompt'),quick=page.locator('#rcBotQuick');
  check('no quick actions on the empty hero',await quick.isHidden());
  await prompt.fill('hello bot');await page.locator('#sendBtn').click();
  await page.waitForFunction(()=>document.getElementById('rcBotStatus').textContent==='Working…',null,{timeout:4000});
  check('the status line says Working… during a turn',await page.locator('#rcBotHead .bot-orb').getAttribute('data-state')==='working');
  check('quick actions are hidden while a turn runs',await quick.isHidden());
  await page.waitForFunction(()=>document.getElementById('rcBotStatus').textContent==='Idle',null,{timeout:15000});
  await page.waitForSelector('#chat>.msg.assistant',{timeout:5000});await page.waitForTimeout(500);
  await page.evaluate(()=>document.activeElement&&document.activeElement.blur());await page.waitForTimeout(200);
  check('quick actions show on a non-empty, idle chat with an empty composer',await quick.isVisible()&&await quick.locator('.rc-bot-chip').count()===4);
  const before=await page.locator('#composerBox').evaluate(c=>c.getBoundingClientRect().bottom);
  await prompt.click();await prompt.type('x');
  check('typing hides the quick actions and the composer stays put',await quick.isHidden()&&Math.abs(before-await page.locator('#composerBox').evaluate(c=>c.getBoundingClientRect().bottom))<=1);
  await prompt.fill('');await page.waitForTimeout(100);
  check('clearing the box brings them back',await quick.isVisible());
  const sent=await page.locator('#chat .msg.user').count();
  await quick.locator('.rc-bot-chip').nth(1).click();
  check('a quick chip prefills and keeps the focus in the prompt',await prompt.inputValue()==='Does anything need me?'&&await page.evaluate(()=>document.activeElement.id==='prompt'));
  await page.waitForTimeout(500);
  check('a quick chip never sends',await page.locator('#chat .msg.user').count()===sent);
  check('the row hides once the prompt has text',await quick.isHidden());
  await prompt.fill('');await page.evaluate(()=>document.activeElement.blur());await page.waitForTimeout(200);
  briefHold=0;await quick.locator('.rc-brief').click();
  await page.waitForFunction(()=>document.getElementById('rcBotBriefStatus').textContent==='Brief requested',null,{timeout:4000});
  check('the Brief chip in the row calls the brief action',true);
  await page.waitForTimeout(2500);
  await page.screenshot({path:'/tmp/bot-visuals2/test-chat.png'});
  // Message text stays readable over the aurora (worst case: the strongest tint over the page colour).
  const [mt,mbg]=await page.evaluate(()=>[getComputedStyle(document.querySelector('#chat .msg.assistant .content, #chat .msg.assistant')).color,getComputedStyle(document.body).backgroundColor]);
  const mbc=rgb(mbg),worst=mbc.map((v,i)=>v*.84+[76,141,255][i]*.16);
  check('assistant text passes 7:1 over the strongest aurora tint',ratio(rgb(mt),worst)>=7);
  const [ut,ub]=await page.evaluate(()=>{const c=document.querySelector('#chat .msg.user .content');const s=getComputedStyle(c);return [s.color,s.backgroundColor];});
  check('the YOU bubble is opaque and passes 7:1',!/rgba\(.*,\s*0(\.\d+)?\)$/.test(ub)&&ratio(rgb(ut),rgb(ub))>=7);

  // 7. Phone: the strip fits and the row scrolls.
  const phone=await context.newPage();phone.on('pageerror',e=>errors.push(e.stack));await phone.setViewportSize({width:390,height:844});
  await phone.goto(base+botUrl);await phone.locator('#rcBotHead').waitFor({state:'visible',timeout:6000});await phone.waitForTimeout(900);
  const fit=await phone.evaluate(()=>{const h=document.getElementById('rcBotHead'),t=h.closest('.topbar'),r=id=>document.getElementById(id).getBoundingClientRect();return {head:h.scrollWidth<=h.clientWidth,topbar:t.scrollWidth<=t.clientWidth,doc:document.documentElement.scrollWidth<=innerWidth,brief:r('rcBotBriefNow').right<=innerWidth&&r('rcBotBriefNow').width>=32,today:r('rcBotToday').right<=innerWidth,settings:r('rcBotSettings').right<=innerWidth,more:r('moreBtn').right<=innerWidth,order:r('rcBotBriefNow').right<=r('rcBotToday').left+1&&r('rcBotSettings').right<=r('moreBtn').left+1};});
  check('phone: the Bot header fits on one row, nothing overflows',Object.values(fit).every(Boolean));
  check('phone: the Brief button keeps its name without the label',await phone.getByRole('button',{name:'Brief me now'}).first().isVisible());
  check('phone: the Bot topbar stays a single row',await phone.evaluate(()=>document.querySelector('.focus-main>.topbar').getBoundingClientRect().height<=70));
  check('phone: the quick row scrolls sideways on one line',await phone.evaluate(()=>{const q=document.getElementById('rcBotQuick');return !q.hidden&&q.scrollWidth>q.clientWidth&&getComputedStyle(q).overflowX==='auto'&&getComputedStyle(q).flexWrap!=='wrap';}));
  overview.running=[];await phone.locator('#rcBotToday').click();await phone.locator('#rcBotTodayPop').waitFor({timeout:3000});
  check('phone: Today fits the screen',await phone.locator('#rcBotTodayPop').evaluate(p=>{const r=p.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
  await phone.close();

  // 8. Reduced motion: everything still shows, nothing moves.
  const calm=await newContext({reducedMotion:'reduce'});await route(calm);
  const rp=await calm.newPage();rp.on('pageerror',e=>errors.push(e.stack));
  await rp.goto(base+botUrl);await rp.locator('#rcBotHead').waitFor({state:'visible',timeout:6000});await rp.waitForTimeout(900);
  check('reduced motion: header, status and Brief are visible and legible',await rp.evaluate(()=>['rcBotStatus','rcBotBriefAt','rcBotBriefNow','rcBotToday','rcBotSettings'].every(id=>{const e=document.getElementById(id),s=getComputedStyle(e);return e.getBoundingClientRect().width>0&&s.opacity==='1'&&s.visibility==='visible';})));
  check('reduced motion: no animation on the orb, aurora or Brief',await rp.evaluate(()=>getComputedStyle(document.querySelector('#rcBotHead .bot-orb')).animationName==='none'&&getComputedStyle(document.querySelector('.focus-main'),'::before').animationName==='none'));
  check('reduced motion: the quick-action chips (and the Brief chip) are visible',await rp.evaluate(()=>[...document.querySelectorAll('#rcBotQuick .rc-bot-chip')].length===4&&[...document.querySelectorAll('#rcBotQuick .rc-bot-chip')].every(e=>getComputedStyle(e).opacity==='1'&&e.getBoundingClientRect().width>0)));
  check('reduced motion: hovering Brief does not lift it',await (async()=>{await rp.locator('#rcBotBriefNow').hover();return rp.locator('#rcBotBriefNow').evaluate(b=>getComputedStyle(b).transform==='none');})());
  await calm.close();

  // 9. Dark theme contrast for the label.
  const dark=await newContext({colorScheme:'dark'});await dark.addInitScript(()=>localStorage.setItem('x056_theme','dark'));await route(dark);
  const dp=await dark.newPage();dp.on('pageerror',e=>errors.push(e.stack));
  await dp.goto(base+botUrl);await dp.locator('#rcBotBriefNow').waitFor({state:'visible',timeout:6000});await dp.waitForTimeout(600);
  const [dt,db]=await dp.locator('#rcBotBriefNow').evaluate(b=>[getComputedStyle(b).color,getComputedStyle(document.body).backgroundColor]);
  const dbc=rgb(db),dmix=(c,k)=>dbc.map((v,i)=>v*(1-k)+c[i]*k);
  check('the Brief label passes 4.5:1 on its tint (dark)',Math.min(ratio(rgb(dt),dmix([110,162,255],.09)),ratio(rgb(dt),dmix([255,195,171],.11)))>=4.5);
  await dark.close();

  assert.deepEqual(errors,[]);
  console.log('PASS Bot header:',checks.length,'checks');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
