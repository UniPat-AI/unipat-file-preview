import { createPreviewHost, Orchestrator, createHttpHandler } from '/Users/gelx/Desktop/code/unipat-file-preview/packages/node/dist/index.js';
import { InMemoryStore, InMemorySourceProvider, InMemoryArtifactStorage, InMemoryIdempotencyStore, EchoRunner } from '/Users/gelx/Desktop/code/unipat-file-preview/packages/node/dist/inmemory/index.js';
import {createServer, request as httpRequest} from 'node:http';
const ns='review';const log={log(){}};const file={resourceKey:'shared-key',version:'v1'};
function setup(authorize=async()=>({allowed:true}), runner=new EchoRunner()){
 const store=new InMemoryStore(), sourceProvider=new InMemorySourceProvider(), artifactStorage=new InMemoryArtifactStorage();
 sourceProvider.register({...file,filename:'a.txt',extension:'txt',bytes:new TextEncoder().encode('safe synthetic data')});
 const orchestrator=new Orchestrator({namespace:ns,workerId:'w',store,sourceProvider,artifactStorage,runner,logger:log});
 const host=createPreviewHost({namespace:ns,authorize,store,sourceProvider,artifactStorage,idempotencyStore:new InMemoryIdempotencyStore(),orchestrator,logger:log});
 return {store,sourceProvider,artifactStorage,orchestrator,host};
}
const ctx=(tenantId='A')=>({namespace:ns,principal:{tenantId,userId:'user'},signal:new AbortController().signal,requestId:'test'});
// callback correctly authorizes the requested business file inside the current tenant; both tenants have the same local resource key.
const a=setup(async({principal,file:f,action})=>({allowed:['A','B'].includes(principal.tenantId)&&f.resourceKey===file.resourceKey&&action==='view'}));
const state=await a.host.getPreviewState(ctx(),{file,profileId:'standard-v1'});
console.log('view-only GET queued conversion:',state.executionState);await a.orchestrator.tick();
const manifest=await a.host.getManifest(ctx('B'),{previewId:state.previewId,publishedRevision:1});
console.log('tenant B read tenant A manifest:',manifest.preview_id===state.previewId);
a.sourceProvider.isAvailable=async()=>false;
console.log('source unavailable still readable:',!!await a.host.getManifest(ctx(),{previewId:state.previewId,publishedRevision:1}));
const b=setup();const s=await b.host.ensurePreview(ctx(),{file,profileId:'standard-v1'});
const job=await b.store.claimJob({namespace:ns,workerId:'w',leaseDurationMs:1});
await new Promise(r=>setTimeout(r,5));
console.log('expired lease can heartbeat:',await b.store.heartbeat({jobId:job.id,leaseToken:job.leaseToken,leaseDurationMs:1000,stage:'converting',progress:null}));
await b.host.clear(ctx(),{previewId:s.previewId});
await b.store.publishResult({previewId:s.previewId,jobId:job.id,leaseToken:job.leaseToken,manifest:{artifacts:[]},availability:'ready'});
console.log('cleared preview resurrected:',(await b.store.getPreview(s.previewId)).executionState);
b.store.markPreviewExpireAt(s.previewId,0);await b.orchestrator.sweepOnce();
try {await b.host.ensurePreview(ctx(),{file,profileId:'standard-v1'});console.log('regenerate after sweep: OK');}catch(e){console.log('regenerate after sweep:',e.message)}
// Published partial candidate
class PartialRunner extends EchoRunner {async run(...args){const r=await super.run(...args);return {...r,manifest:{...r.manifest,availability:'partial',representations:r.manifest.representations.map(x=>({...x,completeness:'partial'}))}}}}
const c=setup(undefined,new PartialRunner());const cs=await c.host.ensurePreview(ctx(),{file,profileId:'standard-v1'});await c.orchestrator.tick();console.log('partial candidate published as:',(await c.store.getPreview(cs.previewId)).executionState,(await c.store.getResult(cs.previewId,1)).availability);
const server=createServer(createHttpHandler({host:c.host,namespace:ns,resolvePrincipal:async()=>ctx().principal,logger:log}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/file-preview/v1/previews/${cs.previewId}/revisions/1`;
const mr=await fetch(base+'/manifest');const m=await mr.json();console.log('private manifest cache-control:',mr.headers.get('cache-control'));
const wr=await fetch(base+'/sheet-windows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sheet_id:'sheet_2',row_start:50,row_end:100,col_start:20,col_end:40})});console.log('sheet-window actual response:',JSON.stringify(await wr.json()));
const rr=await fetch(base+'/artifacts/'+m.artifacts[0].artifact_id,{headers:{range:'bytes=2-'}});console.log('open range headers:',rr.status,rr.headers.get('content-length'),rr.headers.get('content-range'));await rr.body.cancel();
server.closeAllConnections();await new Promise(r=>server.close(r));
