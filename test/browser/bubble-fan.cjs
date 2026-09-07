const assert=require('node:assert/strict'),{chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8767';
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>{localStorage.setItem('x056_token','browser-fixture-token-0123456789');if(!localStorage.getItem('x056_display_preferences'))localStorage.setItem('x056_display_preferences',JSON.stringify({open:'side',maximize:'page'}));});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForSelector('.cr-task');
 await page.locator('#stageToggle').click();await page.waitForSelector('#stagePinPicker[open]');await page.locator('[data-pin-choice]').first().check();await page.keyboard.press('Escape');
 assert.equal(await page.locator('#stageToggle').evaluate(e=>getComputedStyle(e,'::before').opacity),'0','one chat has no extra circles');
 await page.locator('#stageToggle').hover();await page.waitForTimeout(350);await page.locator('#stageAdd').click();await page.locator('[data-pin-choice]').nth(1).check();await page.locator('[data-pin-choice]').nth(2).check();await page.keyboard.press('Escape');await page.mouse.move(400,200);await page.waitForTimeout(400);
 assert.equal(await page.locator('#stageToggle').evaluate(e=>getComputedStyle(e,'::before').opacity),'1');await page.screenshot({path:'/tmp/x056-fan-collapsed.png'});
 // The expansion has actual in-flight movement, followed by independently labeled circles.
 await page.locator('#stageToggle').hover();assert(await page.locator('.stage-item').evaluateAll(es=>es.some(e=>e.getAnimations().length>0)));
 await page.waitForTimeout(400);assert.equal(await page.locator('.stage-initials').count(),0);assert.equal(await page.locator('.stage-conversation>.ic').count(),3);
 assert(await page.locator('.stage-caption').evaluateAll(es=>es.every(e=>getComputedStyle(e).visibility==='visible'&&getComputedStyle(e).opacity==='1')));
 assert.equal(await page.locator('#stageToggle').evaluate(e=>getComputedStyle(e,'::before').opacity),'0');assert.equal(await page.locator('#stageToggle').evaluate(e=>getComputedStyle(e,'::after').opacity),'0');
 assert(await page.locator('.stage-conversation').evaluateAll(es=>es.every(e=>getComputedStyle(e).outlineStyle==='none')));await page.screenshot({path:'/tmp/x056-fan-expanded.png'});
 const sid=await page.locator('.stage-conversation').first().getAttribute('data-session');await page.locator('.stage-conversation').first().click();await page.waitForFunction(id=>document.querySelector('.stage-conversation[aria-current=true]')?.dataset.session===id,sid);
 for(const mode of ['side','page','modal']){
   if(mode==='page')await page.locator('#chatMax').click();
   if(mode==='modal'){await page.locator('#focusSettings').click();await page.locator('input[name=maximize][value=modal]').check();await page.keyboard.press('Escape');}
   const dimensions=await page.locator('.composer').evaluate(e=>{const r=e.getBoundingClientRect(),p=e.parentElement,s=getComputedStyle(p);return{margin:getComputedStyle(e).marginRight,width:r.width,available:p.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)}});
   assert.equal(dimensions.margin,'0px');assert(Math.abs(dimensions.width-dimensions.available)<2,JSON.stringify({mode,...dimensions}));
 }
 await page.locator('#prompt').fill('The composer uses the full available width.');await page.locator('#stageToggle').hover();await page.waitForTimeout(400);await page.screenshot({path:'/tmp/x056-fan-composer.png'});
 await page.locator('#stageToggle').focus();await page.keyboard.press('Escape');await page.locator('#stageShelf').waitFor({state:'hidden'});assert(await page.locator('#stageShelf').isHidden(),JSON.stringify(await page.locator('#conversationStage').evaluate(e=>({expanded:e.dataset.expanded,aria:document.getElementById('stageToggle').getAttribute('aria-expanded'),animations:document.getAnimations().map(a=>({state:a.playState,time:a.currentTime})),focus:document.activeElement?.id}))));
 await page.emulateMedia({reducedMotion:'reduce'});await page.mouse.move(400,200);await page.locator('#stageToggle').hover();assert(await page.locator('.stage-item').evaluateAll(es=>es.every(e=>e.getAnimations().length===0)));assert(await page.locator('.stage-caption').first().isVisible());
 await page.setViewportSize({width:390,height:844});assert(await page.locator('#conversationStage').isHidden());assert.equal(await page.locator('.composer').evaluate(e=>getComputedStyle(e).marginRight),'0px');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);console.log('PASS colored glyphs, persistent labels, conditional collapsed stack, fan animation, no expanded rings/shadows, full-width composer and reduced motion');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
