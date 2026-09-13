import { readFileSync } from 'node:fs';
import { FrontendReleases } from '../server/frontend-releases.js';
// Run from the baked image, never execute code supplied by the candidate bundle.
const [command,snapshot,revision]=process.argv.slice(2);
const runtime='/app',build=JSON.parse(readFileSync(runtime+'/build-info.json','utf8'));
const releases=new FrontendReleases(process.env.X056_STATE_DIR||'/app/state',build.source);
if(command==='publish')console.log(JSON.stringify(releases.publish(snapshot,revision,runtime)));
else if(command==='rollback')console.log(JSON.stringify({active:releases.rollback()?.id||'baked'}));
else if(command==='activate')console.log(JSON.stringify(releases.activate(snapshot)));
else throw new Error('Use publish SNAPSHOT REVISION, activate ID, or rollback');
