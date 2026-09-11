import {readFile,cp} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createPreviewHost,Orchestrator,createHttpHandler} from '../../../packages/node/dist/index.js';
import {InMemoryStore,InMemorySourceProvider,InMemoryArtifactStorage,InMemoryIdempotencyStore} from '../../../packages/node/dist/inmemory/index.js';
const fixtureRoot=process.argv[2]??'/tmp/unipat-review2-fixtures';
for(const name of ['real.txt','real.csv','real.xlsx']) {
 const result=JSON.parse(await readFile(`${fixtureRoot}/${name}.result.json`,'utf8'));
 // Bridge only the Runner's top-level field spelling. Keep converter artifact bytes unchanged.
 const runner={async run(_input,_source,out){await cp(`${fixtureRoot}/${name}-out`,out,{recursive:true});return {manifest:result.manifest,artifacts:result.manifest.artifacts.map(a=>({relativePath:a.path,role:a.role,mediaType:a.media_type,sizeBytes:a.size_bytes,sha256:a.sha256})),warnings:[]}}};
 const ns='review', logger={log(){}},store=new InMemoryStore({namespace:ns}),sourceProvider=new InMemorySourceProvider(),artifactStorage=new InMemoryArtifactStorage();
 const file={resourceKey:name,version:'v1'};
 sourceProvider.register({...file,filename:name,extension:name.split('.').pop(),bytes:await readFile(`${fixtureRoot}/${name}`)});
 const orchestrator=new Orchestrator({namespace:ns,workerId:'review',store,sourceProvider,artifactStorage,runner,logger});
 const host=createPreviewHost({namespace:ns,authorize:async()=>({allowed:true}),store,sourceProvider,artifactStorage,idempotencyStore:new InMemoryIdempotencyStore(),orchestrator,logger});
 const ctx={namespace:ns,principal:{tenantId:'review',userId:'review'},signal:new AbortController().signal,requestId:'review'};
 const s=await host.ensurePreview(ctx,{file,profileId:'standard-v1'});await orchestrator.tick();
 const m=await host.getManifest(ctx,{previewId:s.previewId,publishedRevision:1});
 const id=m.representations[0].entry_artifact_id;
 const e=await host.getArtifact(ctx,{previewId:s.previewId,publishedRevision:1,artifactId:id});const index=JSON.parse(await new Response(e.stream).text());
 console.log(name,'published IDs:',m.artifacts.map(a=>a.artifact_id));
 const chunk=index.chunk_ids?.[0]??index.sheets?.[0].chunks?.[0].artifact_id;
 console.log('index chunk reference:',chunk);
 try {await host.getArtifact(ctx,{previewId:s.previewId,publishedRevision:1,artifactId:chunk});console.log('chunk readable')}catch(e){console.log('chunk fetch error:',e.code,e.httpStatus)}
 if(name!=='real.txt') {
  const server=createServer(createHttpHandler({host,namespace:ns,resolvePrincipal:async()=>ctx.principal,logger}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/file-preview/v1/previews/${s.previewId}/revisions/1/sheet-windows`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sheet_id:'sheet_1',row_start:1,row_end:2,col_start:1,col_end:2})});
  console.log('sheet window:',response.status,await response.text());server.closeAllConnections();await new Promise(r=>server.close(r));
 }
}
