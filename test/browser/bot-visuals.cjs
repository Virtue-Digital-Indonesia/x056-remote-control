/* The Bot's animation and visuals: the orb (header, hero, setup card, pinned row), the empty-chat hero and its
 * chips, the live working state, the sidebar wiggle, and that reduced motion leaves everything visible.
 * Isolated gateway only. /api/bot* is mocked and the Bot flag is added to real, empty chats (as bot-entry does).
 * Run the fixture with X056_CHAT_ENABLED=1 X056_PROJECT_SPACES_ENABLED=1. */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:4391',token='browser-fixture-token-0123456789';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use the isolated localhost fixture');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const errors=[],checks=[];
  const check=(name,value)=>{assert(value,name);checks.push(name);};
  const newContext=async opts=>{const c=await browser.newContext({viewport:{width:1280,height:860},...opts});await c.addInitScript(t=>localStorage.setItem('x056_token',t),token);return c;};
  const context=await newContext();
  const api=async(path,data)=>{const r=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  const botChat=await api('/api/chats',{requestId:randomUUID(),name:'Assistant',provider:'claude'});
  const botUrl='/chat/'+encodeURIComponent(botChat.id);
  const calm=await api('/api/chats',{requestId:randomUUID(),name:'Calm assistant',provider:'claude'});
  let botId=botChat.id,botState={enabled:false,projectId:null,sessionId:null,briefAt:'07:30',tz:'Asia/Jakarta',lastBriefDate:null,url:null};
  const briefs=[];
  const route=async ctx=>{
   await ctx.route('**/api/bot',async r=>{const req=r.request();
    if(req.method()==='POST'){const body=req.postDataJSON();botState={...botState,...body,enabled:body.enabled!==false,projectId:botId,url:'/chat/'+encodeURIComponent(botId)};}
    await r.fulfill({contentType:'application/json',body:JSON.stringify(botState)});});
   await ctx.route('**/api/bot/brief',async r=>{briefs.push(r.request().method());await r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})});});
   await ctx.route(/\/api\/projects(\?|$)/,async r=>{const response=await r.fetch(),data=await response.json();for(const p of data.projects||data.chats||[])if(p.id===botId)p.bot=true;await r.fulfill({response,json:data});});
  };
  await route(context);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack));
  const go=async path=>{await page.goto(base+path);await page.waitForTimeout(900);};

  // 1. Setup card.
  await go('/bot');
  const card=page.locator('#rcBotSetup');
  check('setup card has the 72px orb',await card.locator('.bot-orb').evaluate(o=>o.offsetWidth===72));
  check('setup card has an aurora',await card.locator('.bot-aurora').count()===1);
  check('setup card keeps its heading, time and button',await card.getByRole('heading',{name:'Set up your Bot'}).isVisible()&&await card.locator('input[type=time]').isVisible()&&await card.getByRole('button',{name:'Enable Bot'}).isVisible());
  await page.waitForTimeout(900);
  check('setup card children are fully visible after the entrance',await card.evaluate(c=>[...c.querySelectorAll('.rc-bot-card>*')].every(e=>getComputedStyle(e).opacity==='1')));
  const slow=page.waitForResponse(r=>r.url().endsWith('/api/bot')&&r.request().method()==='POST');
  await card.getByRole('button',{name:'Enable Bot'}).click();
  await slow;
  await page.waitForURL(u=>new URL(u).pathname===botUrl,{timeout:6000});

  // 2. Header orb and the empty-chat hero.
  const head=page.locator('#rcBotHead');await head.waitFor({state:'visible',timeout:5000});
  const hOrb=head.locator('.bot-orb');
  check('the header has a 36px orb (the identity strip)',await hOrb.evaluate(o=>o.offsetWidth===36));
  check('the header orb is idle and labelled',await hOrb.getAttribute('data-state')==='idle'&&await hOrb.getAttribute('aria-label')==='Bot is idle');
  check('the badge still reads Bot',await head.locator('.rc-bot-badge').innerText()==='Bot');
  const hero=page.locator('#rcBotHero');await hero.waitFor({state:'visible',timeout:5000});
  check('the hero has the 72px orb',await hero.locator('.bot-orb').evaluate(o=>o.offsetWidth===72));
  const hour=+new Intl.DateTimeFormat('en-GB',{hour:'numeric',hourCycle:'h23',timeZone:'Asia/Jakarta'}).format(new Date());
  check('the greeting follows the Bot time zone',await hero.locator('h2').innerText()===(hour<12?'Good morning':hour<18?'Good afternoon':'Good evening'));
  check('the hero asks what it can take off your plate',/What can I take off your plate\?/.test(await hero.innerText()));
  const chips=hero.locator('.rc-bot-chip');
  check('four suggestion chips',await chips.count()===4);
  check('the hero does not overlap the composer',await page.evaluate(()=>{const h=document.getElementById('rcBotHero').getBoundingClientRect(),c=document.querySelector('.composer-wrap').getBoundingClientRect();return h.bottom<=c.top+0.5;}));
  await page.waitForTimeout(1300);
  check('hero text and chips are visible after the entrance',await page.evaluate(()=>[...document.querySelectorAll('#rcBotHero h2,#rcBotHero p,#rcBotHero .rc-bot-chip')].every(e=>getComputedStyle(e).opacity==='1')));
  const prompt=page.locator('#prompt'),messages=()=>page.locator('#chat .msg').count();
  await chips.nth(0).click();
  check('a chip prefills the prompt',await prompt.inputValue()==="What's running right now?");
  check('the prompt keeps focus after a chip',await page.evaluate(()=>document.activeElement.id==='prompt'));
  await page.waitForTimeout(700);
  check('a chip never sends',await messages()===0&&await hero.isVisible());
  await chips.nth(2).click();
  check('"Delegate a task…" prefills "Delegate: "',await prompt.inputValue()==='Delegate: ');
  await prompt.fill('');
  await chips.nth(3).click();
  await page.waitForFunction(()=>document.getElementById('rcBotBriefStatus').textContent==='Brief requested',null,{timeout:4000});
  check('"Brief me now" chip posts /api/bot/brief',briefs.length===1&&briefs[0]==='POST');
  check('the orb is happy after a brief',await page.locator('#rcBotHero .bot-orb.happy').count()===1);
  await page.waitForTimeout(1700);
  check('happy ends by itself',await page.locator('.bot-orb.happy').count()===0);
  await page.screenshot({path:'/tmp/bot-visuals/test-hero.png'});

  // 3. A message removes the hero; the header orb works during the turn, then rests.
  await prompt.fill('hello bot');await page.locator('#sendBtn').click();
  await page.waitForFunction(()=>!document.body.classList.contains('rc-bot-empty'),null,{timeout:3000});
  check('the first message removes the hero',await hero.isHidden());
  await page.waitForFunction(()=>document.querySelector('#rcBotHead .bot-orb').dataset.state==='working',null,{timeout:4000});
  check('the header orb is working during a turn',await hOrb.getAttribute('aria-label')==='Bot is working');
  await page.screenshot({path:'/tmp/bot-visuals/test-working.png'});
  await page.waitForFunction(()=>document.querySelector('#rcBotHead .bot-orb').dataset.state==='idle',null,{timeout:15000});
  check('the header orb returns to idle',true);
  await page.waitForSelector('#chat>.msg.assistant',{timeout:5000});
  check('a reply carries the small orb avatar',await page.locator('#chat>.msg.assistant').first().evaluate(m=>{const s=getComputedStyle(m,'::before');return s.width==='22px'&&s.backgroundImage.includes('conic-gradient');}));
  // A reload of a non-empty chat never shows the hero.
  await go(botUrl);await page.waitForTimeout(500);
  check('a chat with history shows no hero',await hero.isHidden());

  // 4. Pinned row and sidebar.
  await go('/chat');
  const row=page.locator('#rcChatList a.rc-chat-item').first();await row.waitFor({timeout:6000});
  check('the pinned Bot row has a 16px orb next to the badge',await row.locator('.bot-orb').evaluate(o=>o.offsetWidth===16)&&await row.locator('.rc-bot-badge').innerText()==='Bot');
  const dest=page.locator('#workspaceBot');
  check('nothing animates on the sidebar Bot icon at rest',await dest.locator('svg').evaluate(s=>getComputedStyle(s).animationName==='none'));
  await dest.hover();
  check('hover wiggles the sidebar Bot icon',await dest.locator('svg').evaluate(s=>getComputedStyle(s).animationName==='ws-bot-wiggle'));

  // 5. Reduced motion: the base styles are the visible end state.
  const calmContext=await newContext({reducedMotion:'reduce'});botId=calm.id;botState={...botState,enabled:false,url:null};await route(calmContext);
  const reduced=await calmContext.newPage();reduced.on('pageerror',e=>errors.push(e.stack));
  await reduced.goto(base+'/bot');await reduced.waitForTimeout(900);
  check('reduced motion: the setup card is visible',await reduced.evaluate(()=>[...document.querySelectorAll('#rcBotSetup .rc-bot-card>*')].filter(e=>getComputedStyle(e).display!=='none').every(e=>getComputedStyle(e).opacity==='1')&&getComputedStyle(document.querySelector('#rcBotSetup button[type=submit]')).opacity==='1'));
  await reduced.screenshot({path:'/tmp/bot-visuals/reduced-setup.png'});
  await reduced.getByRole('button',{name:'Enable Bot'}).click();
  await reduced.locator('#rcBotHero').waitFor({state:'visible',timeout:6000});
  check('reduced motion: hero text and chips are visible',await reduced.evaluate(()=>{const els=[...document.querySelectorAll('#rcBotHero h2,#rcBotHero p,#rcBotHero .rc-bot-chip')];return els.length===6&&els.every(e=>getComputedStyle(e).opacity==='1'&&e.getBoundingClientRect().height>0);}));
  check('reduced motion: nothing is animating',await reduced.evaluate(()=>getComputedStyle(document.querySelector('#rcBotHero .rc-bot-chip')).animationName==='none'&&getComputedStyle(document.querySelector('#rcBotHero .bot-orb')).animationName==='none'));
  await reduced.screenshot({path:'/tmp/bot-visuals/reduced-hero.png'});
  await calmContext.close();
  assert.deepEqual(errors,[]);
  console.log('PASS Bot visuals:',checks.length,'checks');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
