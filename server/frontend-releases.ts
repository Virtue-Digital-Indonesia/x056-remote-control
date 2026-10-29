import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFingerprint } from './version.js';
import { writeState } from './workspace-store.js';

export const frontendFiles = ['panel.html','control-room.js','control-room.css','rc-chat.js','rc-chat.css','project-spaces.js','project-spaces.css','workspace.js','workspace.css','motion.js','webauthn.js','gsap.min.js','manifest.webmanifest','icon-16.png','icon-32.png','icon-180.png','icon-192.png','icon-512.png','icon-512-maskable.png'];
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const sync=(file:string)=>{const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};
const validId=(id:string)=>/^[a-f0-9]{64}$/.test(id);
// Identity of a file's current content for memoization: a rewrite (or an
// atomic rename over it) changes at least one of these.
const statKey=(file:string)=>{const s=statSync(file);return s.ino+':'+s.size+':'+s.mtimeMs;};
export interface FrontendManifest { id:string; revision:string; backendSource:string; files:Record<string,string> }
export class FrontendReleases {
  readonly root:string;
  // Every read below is memoized by the file's stat key, so a request costs a
  // stat instead of a read + parse + sha256; a changed file is re-read and
  // re-verified. Only successful results are kept.
  private manifests=new Map<string,{key:string;m:FrontendManifest}>();
  private assets=new Map<string,{key:string;data:Buffer}>();
  private pointer?:{key:string;id:unknown};
  private page?:{id:string;backend:string;source:Buffer;html:string};
  constructor(stateDir:string,readonly backendSource:string){this.root=join(stateDir,'frontend-releases');}
  manifest(id:string):FrontendManifest {
    if(!validId(id))throw new Error('Invalid frontend release');
    const file=join(this.root,id,'release.json'),key=statKey(file),hit=this.manifests.get(id);
    if(hit&&hit.key===key)return hit.m;
    const m=JSON.parse(readFileSync(file,'utf8')) as FrontendManifest;
    if(m.id!==id||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(m.revision)||m.id!==hash(JSON.stringify([m.revision,m.backendSource,m.files])))throw new Error('Invalid frontend manifest');
    this.manifests.set(id,{key,m});
    return m;
  }
  current():FrontendManifest|undefined {
    try{
      const file=join(this.root,'current.json'),key=statKey(file);
      if(this.pointer?.key!==key)this.pointer={key,id:JSON.parse(readFileSync(file,'utf8')).id};
      const m=this.manifest(this.pointer.id as string);return m.backendSource===this.backendSource?m:undefined;
    }catch{return undefined;}
  }
  asset(id:string,name:string):Buffer {
    if(!frontendFiles.includes(name))throw new Error('Unknown frontend asset');
    const m=this.manifest(id),file=join(this.root,id,name);
    if(!lstatSync(file).isFile())throw new Error('Invalid frontend asset');
    const cacheKey=id+'/'+name,key=statKey(file)+':'+m.files[name],hit=this.assets.get(cacheKey);
    if(hit&&hit.key===key)return hit.data;
    let data=readFileSync(file);if(hash(data)!==m.files[name])throw new Error('Frontend asset checksum mismatch');
    if(name==='manifest.webmanifest'){let text=data.toString();for(const icon of frontendFiles.filter(n=>n.endsWith('.png')))text=text.split('/'+icon).join('/ui-releases/'+id+'/'+icon);data=Buffer.from(text);}
    // Old tabs keep fetching their own release, so keep a few releases' worth.
    this.assets.delete(cacheKey);this.assets.set(cacheKey,{key,data});if(this.assets.size>frontendFiles.length*3)this.assets.delete(this.assets.keys().next().value as string);
    return data;
  }
  activate(id:string){
    const m=this.manifest(id);if(m.backendSource!==this.backendSource)throw new Error('Frontend requires a different backend');
    for(const file of frontendFiles)this.asset(id,file);
    const previous=this.current();
    if(previous?.id===id)return m;
    writeState(join(this.root,'current.json'),{id,previous:previous?.id||null});return m;
  }
  rollback(){
    const p=JSON.parse(readFileSync(join(this.root,'current.json'),'utf8'));
    if(p.previous)return this.activate(p.previous);
    // A null pointer selects the image-baked frontend without touching agents.
    writeState(join(this.root,'current.json'),{id:null,previous:p.id});return undefined;
  }
  publish(snapshot:string,revision:string,runtimeRoot:string){
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('A full commit revision is required');
    if(sourceFingerprint(snapshot)!==this.backendSource)throw new Error('Backend source changed; use an idle backend release');
    for(const file of ['package.json','package-lock.json','server/public/sw.js']){
      if(hash(readFileSync(join(snapshot,file)))!==hash(readFileSync(join(runtimeRoot,file))))throw new Error(file+' changed; use an idle backend release');
    }
    const files:Record<string,string>={},contents=new Map<string,Buffer>();
    for(const name of frontendFiles){const file=join(snapshot,'server/public',name);if(!lstatSync(file).isFile())throw new Error('Asset must be a regular file');const body=readFileSync(file);files[name]=hash(body);contents.set(name,body);}
    const m:FrontendManifest={id:hash(JSON.stringify([revision,this.backendSource,files])),revision,backendSource:this.backendSource,files};
    mkdirSync(this.root,{recursive:true});const dir=join(this.root,m.id);
    if(!existsSync(dir)){
      const temp=join(this.root,'.staging-'+randomUUID());mkdirSync(temp);
      try{for(const [name,body] of contents){writeFileSync(join(temp,name),body,{mode:0o444});sync(join(temp,name));}writeState(join(temp,'release.json'),m);renameSync(temp,dir);sync(this.root);}finally{rmSync(temp,{recursive:true,force:true});}
    }
    return this.activate(m.id);
  }
  html(m:FrontendManifest,backend:unknown){
    const source=this.asset(m.id,'panel.html'),backendJson=JSON.stringify(backend);
    if(this.page&&this.page.id===m.id&&this.page.backend===backendJson&&this.page.source===source)return this.page.html;
    let html=source.toString();
    for(const name of frontendFiles.filter(n=>n!=='panel.html'))html=html.split('/'+name).join('/ui-releases/'+m.id+'/'+name);
    const info=JSON.stringify({backend,ui:{revision:m.revision.slice(0,7),fingerprint:m.id,dirty:false}}).replace(/</g,'\\u003c');
    html=html.replace('</head>','<script>window.X056_RELEASE='+info+';</script></head>');
    this.page={id:m.id,backend:backendJson,source,html};
    return html;
  }
}
