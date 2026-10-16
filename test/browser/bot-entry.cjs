/* The Bot's entry points in the panel: /bot (setup card, then the Bot chat), the workspace
 * destination, the pinned row in /chat, and the Bot header (badge, brief time, Brief me now).
 * Isolated gateway only. /api/bot* is mocked, and the Bot flag is added to one real chat row.
 * Run the fixture with X056_CHAT_ENABLED=1 X056_PROJECT_SPACES_ENABLED=1. */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:4391',token='browser-fixture-token-0123456789';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use the isolated localhost fixture');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);
  const errors=[],checks=[];
  const check=(name,value)=>{assert(value,name);checks.push(name);};
  const api=async(path,data)=>{const r=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
  // Two chats: the Bot (older, so only the pin can put it first) and an ordinary one.
  const botChat=await api('/api/chats',{requestId:randomUUID(),name:'Assistant',provider:'claude'});
  await new Promise(r=>setTimeout(r,50));
  const other=await api('/api/chats',{requestId:randomUUID(),name:'Ordinary chat',provider:'claude'});
  const botUrl='/chat/'+encodeURIComponent(botChat.id);
  // The mocked Bot record, and what the panel sent.
  let botState={enabled:false,projectId:null,sessionId:null,briefAt:'07:30',tz:'Asia/Jakarta',lastBriefDate:null,url:null};
  const posted=[],briefs=[];let briefFails=false,enableFails=false;
  await context.route('**/api/bot',async route=>{
   const req=route.request();
   if(req.method()==='POST'){const body=req.postDataJSON();posted.push(body);
    if(enableFails)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'Bot store unavailable'})});
    botState={...botState,...body,enabled:body.enabled!==false,projectId:botChat.id,sessionId:botChat.lastSessionId,url:botUrl};}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(botState)});
  });
  await context.route('**/api/bot/brief',async route=>{briefs.push(route.request().method());await new Promise(r=>setTimeout(r,400));
   if(briefFails)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({message:'A brief is already running'})});
   await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})});});
  // The server marks the Bot's chat row with bot: true.
  const flag=async route=>{const response=await route.fetch(),data=await response.json();for(const p of data.projects||data.chats||[])if(p.id===botChat.id)p.bot=true;await route.fulfill({response,json:data});};
  await context.route(/\/api\/projects(\?|$)/,flag);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack));
  const go=async path=>{await page.goto(base+path);await page.waitForTimeout(900);};

  // 1. /bot with the Bot off: the setup card.
  await go('/bot');
  const card=page.locator('#rcBotSetup');
  check('/bot shows the setup card',await card.getByRole('heading',{name:'Set up your Bot'}).isVisible());
  check('the card says what the Bot does',/hands work to the right conversation/.test(await card.innerText())&&/every morning/.test(await card.innerText()));
  check('brief time defaults to 07:30',await card.locator('input[type=time]').inputValue()==='07:30');
  check('the time zone is named',/Asia\/Jakarta/.test(await card.innerText()));
  check('the URL stays /bot while setting up',new URL(page.url()).pathname==='/bot');
  check('the Bot destination is current on /bot',await page.locator('#workspaceBot').getAttribute('aria-current')==='page');
  await page.screenshot({path:'/tmp/bot-setup-1280.png'});
  // An error stays on the card.
  enableFails=true;await card.getByRole('button',{name:'Enable Bot'}).click();
  await page.waitForFunction(()=>/Bot store unavailable/.test(document.querySelector('#rcBotSetup [role=alert]').textContent),null,{timeout:4000});
  check('an enable error is shown inline',true);
  check('a failed enable stays on /bot',new URL(page.url()).pathname==='/bot');
  enableFails=false;
  // Enable with a chosen time: posts it, then opens the Bot chat.
  await card.locator('input[type=time]').fill('06:45');
  await card.getByRole('button',{name:'Enable Bot'}).click();
  await page.waitForURL(u=>new URL(u).pathname===botUrl,{timeout:6000});
  check('Enable posts enabled + briefAt',posted.at(-1).enabled===true&&posted.at(-1).briefAt==='06:45');
  check('Enable opens the Bot chat',new URL(page.url()).pathname===botUrl);
  await page.waitForTimeout(600);
  check('the setup card is gone in the chat',!(await card.isVisible()));

  // 2. Header on the Bot chat.
  const head=page.locator('#rcBotHead');
  await head.waitFor({state:'visible',timeout:5000});
  check('the Bot chat header has a Bot badge',await head.locator('.rc-bot-badge').innerText()==='Bot');
  check('the header shows the next brief time',(await page.locator('#rcBotBriefAt').innerText())==='Next brief 06:45');
  const brief=head.getByRole('button',{name:'Brief me now'});
  await brief.click();
  check('Brief me now is disabled while pending',await brief.isDisabled());
  await page.waitForFunction(()=>document.getElementById('rcBotBriefStatus').textContent==='Brief requested',null,{timeout:4000});
  check('Brief me now POSTs /api/bot/brief',briefs.length===1&&briefs[0]==='POST');
  check('Brief me now is enabled again after the reply',!(await brief.isDisabled()));
  briefFails=true;await brief.click();
  await page.waitForFunction(()=>/already running/.test(document.getElementById('rcBotBriefStatus').textContent),null,{timeout:4000});
  check('a failed brief says why',await page.locator('#rcBotBriefStatus.error').count()===1);
  briefFails=false;
  await page.screenshot({path:'/tmp/bot-chat-1280.png'});

  // 3. /bot once enabled goes straight to the chat, replacing /bot in history.
  await go('/home');await go('/bot');
  await page.waitForURL(u=>new URL(u).pathname===botUrl,{timeout:6000});
  check('/bot with the Bot on opens its chat',true);

  // 4. The header is only for the Bot.
  await go('/chat/'+encodeURIComponent(other.id));
  check('no Bot header on an ordinary chat',await head.isHidden());

  // 5. /chat: the Bot pinned first, with a badge.
  await go('/chat');
  const rows=page.locator('#rcChatList a.rc-chat-item');await rows.first().waitFor({timeout:6000});
  check('the Bot chat is pinned first in /chat',await rows.first().getAttribute('data-chat')===botChat.id);
  check('the Bot row has a Bot badge',await rows.first().locator('.rc-bot-badge').innerText()==='Bot');
  check('ordinary rows have no Bot badge',await page.locator('#rcChatList a.rc-chat-item:not([data-chat="'+botChat.id+'"]) .rc-bot-badge').count()===0);
  await page.screenshot({path:'/tmp/bot-list-1280.png'});

  // 6. The workspace destination goes to /bot (and on to the chat).
  const dest=page.locator('#workspaceBot');
  check('a Bot destination sits in the workspace sidebar',await dest.isVisible()&&(await dest.innerText()).trim()==='Bot');
  check('it is styled like its siblings',await dest.evaluate(a=>{const s=a.parentElement.querySelector('#crHomeTab');return !!s&&a.className===s.className&&getComputedStyle(a).fontSize===getComputedStyle(s).fontSize;}));
  await dest.click();
  await page.waitForURL(u=>new URL(u).pathname===botUrl,{timeout:6000});
  check('the destination opens the Bot',true);

  // 7. A bot_notice live event (the standard notice object) shows in the bell, on another page.
  const bell=await context.newPage();bell.on('pageerror',e=>errors.push(e.stack));
  const at=new Date().toISOString(),notice={tier:'urgent',category:'needs_you',kind:'bot_notice',title:'Deploy needs your OK',body:'The x056 build passed. Swap now?',link:botUrl,tag:'x056-bot-1',id:'bot:1',projectId:botChat.id,sessionId:botChat.lastSessionId};
  await bell.route(/\/api\/sessions\/current\/stream/,route=>route.fulfill({status:200,headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'},body:'id: 900\nevent: bot_notice\ndata: '+JSON.stringify({ts:at,data:{notice}})+'\n\n'}));
  // The gateway's read state (server/read-state.ts) is left out here: this checks the live event alone.
  await bell.route(/\/api\/conversations\/read-state/,route=>route.fulfill({status:404,contentType:'application/json',body:'{}'}));
  await bell.goto(base+'/home');await bell.waitForTimeout(1500);
  await bell.locator('#crNotifications').click();
  const dialog=bell.locator('.rc-notification-dialog');await dialog.waitFor({timeout:4000});
  const needsYou=dialog.locator('.rc-notification-group',{hasText:'Needs you'});
  check('a bot_notice shows in the bell under Needs you',await needsYou.getByText('Deploy needs your OK').isVisible()&&await needsYou.getByText('Swap now?').isVisible());
  await dialog.getByText('Deploy needs your OK').click();
  await bell.waitForURL(u=>new URL(u).pathname===botUrl,{timeout:6000});
  check('opening it goes to the Bot chat',true);
  await bell.close();

  // 8. Phone width: the setup card and the Bot header fit.
  const phone=await context.newPage();phone.on('pageerror',e=>errors.push(e.stack));await phone.setViewportSize({width:390,height:844});
  await phone.goto(base+botUrl);await phone.locator('#rcBotHead').waitFor({state:'visible',timeout:6000});await phone.waitForTimeout(500);
  const fits=await phone.evaluate(()=>{const r=document.getElementById('rcBotHead').getBoundingClientRect(),b=document.getElementById('rcBotBriefNow').getBoundingClientRect();return r.right<=innerWidth+0.5&&b.right<=innerWidth+0.5&&b.width>0&&document.documentElement.scrollWidth<=innerWidth;});
  check('the Bot header fits a 390px phone',fits);
  await phone.screenshot({path:'/tmp/bot-chat-390.png'});
  botState={...botState,enabled:false,url:null};
  await phone.goto(base+'/bot');await phone.waitForTimeout(900);
  check('the setup card fits a 390px phone',await phone.evaluate(()=>{const c=document.querySelector('.rc-bot-card').getBoundingClientRect();return c.width>0&&c.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;}));
  await phone.screenshot({path:'/tmp/bot-setup-390.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS Bot entry points:',checks.length,'checks');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
