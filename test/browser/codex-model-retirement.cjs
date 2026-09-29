const fs=require('fs'),assert=require('assert/strict'),{chromium}=require('/usr/local/lib/node_modules/playwright');
(async()=>{const html=fs.readFileSync('server/public/panel.html','utf8');const b=await chromium.launch({args:['--no-sandbox']});try{const p=await b.newPage();await p.setContent('<select id="model"></select>');const aliases=html.slice(html.indexOf('  var LEGACY_MODEL_IDS'),html.indexOf('  // The model actually sent'));
const options=html.slice(html.indexOf('  function setModelOptions'),html.indexOf('  // What "Auto model"'));
await p.addScriptTag({content:'var modelEl=document.getElementById("model");\n'+aliases+options});
const pick=(offered,saved)=>p.evaluate(([o,s])=>{setModelOptions([{value:'',label:'Auto'}].concat(o.map(v=>({value:v,label:v}))),s);return modelEl.value},[offered,saved]);
for(const tier of ['sol','luna'])assert.equal(await pick(['gpt-6-'+tier],'gpt-5.6-'+tier),'gpt-6-'+tier);
// GPT-6.1-Sol replaces GPT-6-Sol once the list offers it, and not before.
assert.equal(await pick(['gpt-6.1-sol','gpt-6-astra'],'gpt-6-sol'),'gpt-6.1-sol');
assert.equal(await pick(['gpt-6.1-sol'],'gpt-5.6-sol'),'gpt-6.1-sol');
assert.equal(await pick(['gpt-6-sol','gpt-6-astra'],'gpt-6-sol'),'gpt-6-sol');
assert.equal(await pick(['gpt-6-astra'],'gpt-6-sol'),'');
console.log('PASS browser picker migrates saved retired selections to the newest offered model');}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
