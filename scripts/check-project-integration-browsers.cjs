// Each workflow gets its own gateway, state, account fixtures, and provider processes.
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const output=process.env.X056_BROWSER_CHECK_OUTPUT||'/tmp/project-integration-browser-checks',port=Number(process.env.X056_BROWSER_CHECK_PORT||8775);fs.mkdirSync(output,{recursive:true});
const cases=[['project-integration',true],['project-integration-handoffs',true],['project-spaces',true],['project-spaces-workflow',true],['project-memory-sharing',true],['project-memory-documents',true],['rc-chat',false],['rc-chat-navigation',false],['memory-v5',false],['project-integration-disabled',false],['project-release-surfaces',true]];
const selected=process.argv.slice(2),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){for(const [name,enabled] of cases.filter(([name])=>!selected.length||selected.includes(name))){
 const fixtureLog=fs.openSync(path.join(output,name+'-fixture.log'),'w'),checkLog=fs.openSync(path.join(output,name+'.log'),'w');
 const fixture=spawn(process.execPath,['--import','tsx','test/browser/fixture.ts'],{detached:true,env:{...process.env,X056_CHAT_ENABLED:'1',X056_PROJECT_SPACES_ENABLED:enabled?'1':'0',X056_TEST_CHAT:'1',X056_TEST_PORT:String(port),X056_TEST_SPACE_DISABLE:name==='project-integration-disabled'?'1':'0'},stdio:['ignore',fixtureLog,fixtureLog]});
 const stopped=new Promise(r=>fixture.once('exit',r));
 try{let ready=false;for(let i=0;i<150;i++){if(fixture.exitCode!==null)throw new Error(name+': fixture stopped');try{const r=await fetch('http://127.0.0.1:'+port+'/api/projects',{headers:{Authorization:'Bearer browser-fixture-token-0123456789'}});if(r.ok){ready=true;break;}}catch{}await delay(200);}if(!ready)throw new Error(name+': fixture startup timeout');
 const child=spawn(process.execPath,['test/browser/'+name+'.cjs','http://127.0.0.1:'+port],{stdio:['ignore',checkLog,checkLog]});
 const status=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(name+': browser timeout'));},180000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
 if(status!==0)throw new Error(name+': failed; see '+path.join(output,name+'.log'));console.log(name+': PASS');
 }finally{try{process.kill(-fixture.pid,'SIGTERM');}catch{}await Promise.race([stopped,delay(3000)]);try{process.kill(-fixture.pid,'SIGKILL');}catch{}fs.closeSync(fixtureLog);fs.closeSync(checkLog);}
}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
