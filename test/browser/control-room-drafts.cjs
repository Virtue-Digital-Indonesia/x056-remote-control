// Run fixture.ts first, then: node test/browser/control-room-drafts.cjs [base URL]
const assert = require('node:assert/strict');
let playwright; try { playwright=require('playwright'); } catch { playwright=require('/usr/local/lib/node_modules/playwright'); }
const { chromium } = playwright;
const base = process.argv[2] || 'http://127.0.0.1:8768';

(async () => {
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
  const page=await context.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const pause=()=>page.waitForTimeout(150);
  const open=async title=>{
    await page.locator('.cr-task').filter({hasText:title}).click();
    await page.waitForFunction(()=>!document.getElementById('conversationSurface').hidden);
  };
  const close=async()=>{await page.locator('#chatClose').click();await pause();};

  await page.goto(base);
  await page.waitForSelector('.cr-task');
  await open('Update the component library');
  await page.locator('#prompt').fill('Keep this unsent draft.');
  await close();
  await open('Review accessibility findings');
  await page.locator('#prompt').fill('Separate draft.');
  await close();

  await page.getByRole('button',{name:'Draft',exact:true}).click();
  const drafts=page.locator('.cr-conversation-group').filter({has:page.getByRole('heading',{name:'Drafts',exact:true})});
  assert.equal(await drafts.locator('.cr-task').count(),2);
  assert.equal(await drafts.locator('.cr-draft-tag').count(),2);
  assert.equal(await page.getByRole('heading',{name:'Recent conversations',exact:true}).count(),0);

  await drafts.locator('.cr-task').filter({hasText:'Update the component library'}).click();
  assert.equal(await page.locator('#prompt').inputValue(),'Keep this unsent draft.');
  await page.locator('#prompt').fill('   ');
  await close();
  assert.equal(await drafts.locator('.cr-task').count(),1);
  assert.equal(await drafts.getByText('Update the component library').count(),0);
  assert.deepEqual(errors,[]);
  await browser.close();
  console.log('PASS: unsent drafts are grouped, restored, and removed when cleared.');
})().catch(error=>{console.error(error);process.exit(1);});
