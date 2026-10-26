import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { StudioServer } from '../src/server/StudioServer.js';
import type { CredentialProvider } from '../src/core/security/CredentialStore.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packetlark-p2-api-'));
  const values = new Map<string,string>();
  const provider: CredentialProvider = { get: async (n,id) => { const value=values.get(n+id); if(value===undefined)throw Error('Missing');return value; }, set:async(n,id,value)=>{values.set(n+id,value);}, delete:async(n,id)=>{values.delete(n+id);} };
  const peer = http.createServer(async (req,res) => {
    const bytes=[]; for await(const chunk of req)bytes.push(chunk);
    const body=Buffer.concat(bytes);
    if(req.url==='/binary'){res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.alloc(600*1024,0xab));return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({url:req.url,method:req.method,headers:req.headers,body:body.toString(),bodyBase64:body.toString('base64'),size:body.length}));
  });
  await new Promise<void>(resolve=>peer.listen(0,'127.0.0.1',resolve));
  const target=`http://127.0.0.1:${(peer.address() as any).port}`;
  let server=new StudioServer(0,0,root,{credentialProvider:provider,allowInsecureOAuthForTests:true});
  let base=`http://127.0.0.1:${await server.start()}`;
  const call=async(route:string,method='GET',body?:any)=>{
    const response=await fetch(base+'/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {root,target,values,call,get base(){return base;},restart:async()=>{await server.stop();server=new StudioServer(0,0,root,{credentialProvider:provider,allowInsecureOAuthForTests:true});base=`http://127.0.0.1:${await server.start()}`;},close:async()=>{await server.stop();peer.closeAllConnections();await new Promise<void>(r=>peer.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});}};
}
const request=(url:string,patch:any={})=>({id:'api_request',name:'API request',method:'GET',url,headers:[],queryParams:[],body:{mode:'none'},auth:{type:'none'},...patch});
const collection=(req:any)=>({id:'p2_api',name:'P2 API',schemaVersion:'2.1.0',variables:[],items:[{id:'api_request',name:'API request',request:req}]});
describe('P2 public Studio API',()=>{
  it('resolves origin-bound references, excludes secrets from diagnostics/examples/exports and protects its own management API',async()=>{
    const f=await fixture();const secret='p2-api-seeded-private-token';
    try{
      const created=await f.call('credentials','POST',{label:'Fixture',value:secret,origins:[f.target],storage:'session'});expect(created.status).toBe(200);expect(JSON.stringify(created.data)).not.toContain(secret);
      const req=request(f.target+'/echo',{auth:{type:'bearer',bearerToken:created.data.reference},testScript:'console.log(pm.response.json().headers.authorization); pm.test(pm.response.json().headers.authorization,()=>{});'});
      const saved=await f.call('collections','POST',collection(req));expect(saved.status).toBe(200);
      const response=await f.call('execute','POST',{request:req,collectionId:'p2_api',collectionRevision:saved.data.revision});expect(response.status).toBe(200);expect(response.data.status).toBe(200);expect(JSON.parse(response.data.body).headers.authorization).toBe('Bearer '+secret);
      for(const data of [response.data.logs,response.data.testResults,response.data.example,(await f.call('credentials')).data])expect(JSON.stringify(data)).not.toContain(secret);
      const exported=await f.call('collections/p2_api/export/postman');expect(JSON.stringify(exported.data)).toContain(created.data.reference);expect(JSON.stringify(exported.data)).not.toContain(secret);
      expect(fs.readFileSync(path.join(f.root,'collections','p2_api.json'),'utf8')).not.toContain(secret);
      const blocked=await f.call('execute','POST',{request:request(f.base+'/api/credentials')});expect(blocked.data.status).toBe(0);expect(blocked.data.transportAttempted).toBe(false);
      const foreign=await fetch(f.base+'/api/credentials',{headers:{Origin:'https://untrusted.invalid'}});expect(foreign.status).toBe(403);
    }finally{await f.close();}
  });
  it('allows only owned OAuth callback navigation through the cross-site browser boundary',async()=>{
    const f=await fixture();const headers={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
    try{
      // Node fetch forces Sec-Fetch-Mode:cors; raw HTTP simulates browser navigation metadata.
      const callback=await new Promise<{status:number,body:string}>((resolve,reject)=>{http.get(f.base+'/api/oauth/callback?state=invalid',{headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body}));}).on('error',reject);});
      expect(callback.status).toBe(400);expect(callback.body).toContain('Authorization did not complete');
      expect((await fetch(f.base+'/api/credentials',{headers})).status).toBe(403);
      expect((await fetch(f.base+'/api/oauth/callback?state=invalid',{headers:{...headers,'sec-fetch-mode':'cors'}})).status).toBe(403);
      expect((await fetch(f.base+'/api/oauth/callback?state=invalid',{headers:{...headers,Origin:'https://foreign.invalid'}})).status).toBe(403);
    }finally{await f.close();}
  });
  it('retains unchanged sensitive environment values and refuses resolved-secret script writes',async()=>{
    const f=await fixture();const secret='p2-private-script-copy';
    try{
      const entry=(await f.call('credentials','POST',{label:'Script source',value:secret,origins:[f.target],storage:'session'})).data;
      const env=(await f.call('environments','POST',{id:'p2_env',name:'Script environment',values:[{key:'password',value:'original-inline-private'},{key:'token',value:entry.reference}]})).data;
      let response=await f.call('execute','POST',{request:request(f.target),environmentId:env.id,environmentRevision:env.revision});
      expect(response.data.status).toBe(200);expect((await f.call('environments/p2_env')).data.values[0].value).toBe('original-inline-private');
      response=await f.call('execute','POST',{request:request(f.target,{auth:{type:'bearer',bearerToken:entry.reference},testScript:'pm.environment.set("copied",pm.response.json().headers.authorization);'}),environmentId:env.id,environmentRevision:env.revision});
      expect(response.data.persistence.environment.code).toBe('ERR_SECRET_PERSISTENCE');expect(JSON.stringify((await f.call('environments/p2_env')).data)).not.toContain(secret);expect(response.data.updatedEnvironment.copied).not.toContain(secret);
    }finally{await f.close();}
  });
  it('rejects unknown modes and invalid API key location before transport or scripts',async()=>{
    const f=await fixture();try{for(const patch of [{auth:{type:'digest'}},{body:{mode:'graphql'}},{auth:{type:'apikey',apiKeyIn:'typo',apiKeyValue:'private'}}]){
      const result=await f.call('execute','POST',{request:request(f.target,{...patch,preRequestScript:'throw Error("script must not run");'})});expect(result.data.transportAttempted).toBe(false);expect(result.data.error.code).toBe('ERR_UNSUPPORTED');
    }}finally{await f.close();}
  });
  it('uploads only selected bytes, streams bounded previews and downloads exact complete artifacts',async()=>{
    const f=await fixture();
    try{
      const bytes=Buffer.from([0,1,255,127,65,66,10]);
      const uploaded=await fetch(f.base+'/api/files',{method:'POST',headers:{'X-File-Name':'chosen.bin','Content-Type':'application/octet-stream'},body:bytes});expect(uploaded.status).toBe(200);const file=await uploaded.json();expect(file.size).toBe(bytes.length);expect(file.path).toBeUndefined();
      const result=await f.call('execute','POST',{request:request(f.target+'/echo',{method:'POST',body:{mode:'binary',fileId:file.id}})});expect(result.data.status).toBe(200);expect(JSON.parse(result.data.body).bodyBase64).toBe(bytes.toString('base64'));
      const invalid=await f.call('execute','POST',{request:request(f.target+'/echo',{method:'POST',body:{mode:'binary',fileId:'/etc/passwd'}})});expect(invalid.data.status).toBe(0);expect(invalid.data.transportAttempted).toBe(false);
      const response=await fetch(f.base+'/api/execute/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:request(f.target+'/binary')})});expect(response.status).toBe(200);
      const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));const complete=events.find(e=>e.type==='complete').response;expect(complete.previewTruncated).toBe(true);expect(complete.bodyEncoding).toBe('base64');expect(complete.sizeBytes).toBe(600*1024);expect(Buffer.from(complete.bodyBase64,'base64').length).toBeLessThanOrEqual(256*1024);
      const download=await fetch(f.base+'/api/responses/'+complete.artifactId);expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.alloc(600*1024,0xab))).toBe(true);
      expect((await f.call('responses/'+complete.artifactId,'DELETE')).status).toBe(200);expect((await fetch(f.base+'/api/responses/'+complete.artifactId)).status).not.toBe(200);
    }finally{await f.close();}
  });
  it('requires migration review/consent/revision and preserves source on a stale apply',async()=>{
    const f=await fixture();const secret='p2-inline-migration-secret';
    try{
      const req=request(f.target+'/echo',{auth:{type:'bearer',bearerToken:secret}});await f.call('collections','POST',collection(req));
      const preview=await f.call('credentials/migration/preview','POST',{kind:'collections',id:'p2_api',origins:[f.target],storage:'session'});expect(preview.status).toBe(200);expect(JSON.stringify(preview.data)).not.toContain(secret);expect(preview.data.fields.length).toBeGreaterThan(0);
      expect((await f.call('credentials/migration/apply','POST',{planId:preview.data.planId})).status).toBe(400);
      const source=(await f.call('collections/p2_api')).data;await f.call('collections/p2_api','PUT',{...source,name:'Newer name'});
      expect((await f.call('credentials/migration/apply','POST',{planId:preview.data.planId,consent:true,sessionLossConsent:true})).status).toBe(412);
      expect((await f.call('collections/p2_api')).data.items[0].request.auth.bearerToken).toBe(secret);
      const next=await f.call('credentials/migration/preview','POST',{kind:'collections',id:'p2_api',origins:[f.target],storage:'session'});
      const applied=await f.call('credentials/migration/apply','POST',{planId:next.data.planId,consent:true,sessionLossConsent:true});expect(applied.status).toBe(200);expect(applied.data.resource.items[0].request.auth.bearerToken).toMatch(/^\{\{secret:/);
      const safe=await f.call('collections/p2_api/export/postman');expect(JSON.stringify(safe.data)).not.toContain(secret);
    }finally{await f.close();}
  });
  it.skipIf(process.platform==='win32')('persists cookies only after secure-store consent and restores them without plaintext workspace values',async()=>{
    const f=await fixture();const cookie='p2-cookie-private-value';
    try{
      expect((await f.call('cookies')).data.persistence.enabled).toBe(false);
      expect((await f.call('cookies/persistence','POST',{enabled:true,storage:'keychain',consent:false})).status).toBe(400);
      expect((await f.call('cookies','PUT',{url:f.target,cookie:'session='+cookie+'; Path=/; HttpOnly'})).status).toBe(200);
      expect((await f.call('cookies/persistence','POST',{enabled:true,storage:'keychain',consent:true})).status).toBe(200);
      const config=fs.readFileSync(path.join(f.root,'private-credentials','cookies-v1.json'),'utf8');const metadata=fs.readFileSync(path.join(f.root,'private-credentials','bindings-v1.json'),'utf8');expect(config+metadata).not.toContain(cookie);
      await f.restart();const response=await f.call('execute','POST',{request:request(f.target+'/echo')});expect(JSON.parse(response.data.body).headers.cookie).toContain(cookie);
      expect((await f.call('cookies/persistence','POST',{enabled:false,consent:true})).status).toBe(200);
      expect((await f.call('cookies/persistence','DELETE',{consent:false})).status).toBe(400);
      expect((await f.call('cookies/persistence','DELETE',{consent:true})).status).toBe(200);
      expect(f.values.size).toBe(0);expect((await f.call('cookies')).data.cookies.length).toBe(1);
      await f.restart();expect((await f.call('cookies')).data.cookies).toEqual([]);
    }finally{await f.close();}
  });
});
