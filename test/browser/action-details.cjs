const assert=require('node:assert/strict'),{chromium}=require('/usr/local/lib/node_modules/playwright');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
 const detail='text(await tools.exec_command({cmd: "'+ 'long command '.repeat(100)+'"}));\n<script>window.actionInjected=true</script>';
 await page.route('**/api/conversations/history-page?*',async route=>{const response=await route.fetch(),data=await response.json();data.rows.push({role:'action',text:'Running commands',detail});await route.fulfill({response,json:data});});
 await page.goto(process.argv[2]||'http://127.0.0.1:8779');
 await page.locator('.cr-task').first().click();
 await page.locator('.thread .act').last().waitFor();
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:900});
  const action=page.locator('.thread .act').last();
  const sizes=await action.evaluate(el=>({row:el.getBoundingClientRect().width,parent:el.parentElement.clientWidth-parseFloat(getComputedStyle(el.parentElement).paddingLeft)-parseFloat(getComputedStyle(el.parentElement).paddingRight)}));
  assert(Math.abs(sizes.row-sizes.parent)<3,JSON.stringify(sizes));
  await action.click();await page.locator('.action-detail').waitFor();
  assert.equal(await page.locator('.action-detail pre').textContent(),detail);
  assert(await page.locator('.action-detail .send').evaluate(el=>el.clientWidth>=el.scrollWidth),'Close button is not clipped');
  assert.equal(await page.evaluate(()=>window.actionInjected),undefined);
  if(process.env.X056_SCREENSHOT_DIR)await page.screenshot({path:process.env.X056_SCREENSHOT_DIR+'/action-'+width+'.png'});
  await page.keyboard.press('Escape');
 }
 await page.keyboard.press('Meta+k');await page.locator('.palette .pal-input').waitFor({state:'visible'});
 await page.keyboard.press('Meta+k');assert.equal(await page.locator('.palette').count(),1);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.palette').count(),0);
 await page.keyboard.press('Control+k');await page.locator('.palette .pal-input').waitFor({state:'visible'});
 await page.keyboard.press('Escape');
 await page.locator('.thread .act').last().focus();await page.keyboard.press('Enter');await page.locator('.action-detail').waitFor();await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('PASS: full-width action details, safe text, keyboard, Cmd/Ctrl+K over conversation dialog, 3 widths');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
