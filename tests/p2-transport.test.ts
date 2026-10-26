import { describe,it,expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { HttpExecutor } from '../src/core/engine/HttpExecutor.js';
import { SelectedFileStore } from '../src/core/engine/SelectedFileStore.js';
import { ResponseArtifactStore } from '../src/core/engine/ResponseArtifactStore.js';
import { CookieManager } from '../src/core/engine/CookieManager.js';
import { SecretRedactor } from '../src/core/security/SecretRedactor.js';
import type { HttpRequest } from '../src/core/models/types.js';
const request=(url:string,patch:Partial<HttpRequest>={}):HttpRequest=>({url,method:'GET',headers:[],queryParams:[],body:{mode:'none'},auth:{type:'none'},...patch});
async function fixture(handler:http.RequestListener){const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,stop:()=>new Promise<void>(r=>server.close(()=>r()))};}
describe('P2 HTTP transport',()=>{
 it('preserves ordered duplicate headers, query and URL encoded form fields on wire',async()=>{
  const target=await fixture(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({headers:req.rawHeaders,url:req.url,body:Buffer.concat(chunks).toString()}));});
  try{const result=await HttpExecutor.execute(request(target.url+'/?x=0',{method:'POST',headers:[{key:'X-Dupe',value:'one'},{key:'X-Dupe',value:'two'}],queryParams:[{key:'x',value:'1'},{key:'x',value:'2'}],body:{mode:'x-www-form-urlencoded',formData:[{key:'a',value:'1'},{key:'a',value:'2'}]}}));expect(result.status).toBe(200);const data=JSON.parse(result.body);expect(data.headers.slice(0,4)).toEqual(['X-Dupe','one','X-Dupe','two']);expect(data.url).toBe('/?x=0&x=1&x=2');expect(data.body).toBe('a=1&a=2');}finally{await target.stop();}
 });
 it('sends custom token methods, rejects CONNECT/TRACE and malformed tokens before transport',async()=>{
  let wire='';const server=net.createServer(socket=>socket.once('data',data=>{wire=data.toString();socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  try{expect((await HttpExecutor.execute(request(url,{method:'CUSTOM'}))).status).toBe(200);expect(wire.startsWith('CUSTOM / HTTP/1.1')).toBe(true);for(const method of ['CONNECT','TRACE','BAD METHOD'])expect((await HttpExecutor.execute(request(url,{method}))).error?.code).toBe('ERR_METHOD');}finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('streams selected binary and multipart file bytes; never treats an imported path as a selection',async()=>{
  const store=new SelectedFileStore();const file=await store.add(Buffer.from([0,255,1,2]),'chosen.bin');let sent:Buffer;
  const target=await fixture(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);sent=Buffer.concat(chunks);res.end('ok');});
  try{const options={resolveFile:(id:string)=>store.resolve(id)};expect((await HttpExecutor.execute(request(target.url,{method:'POST',body:{mode:'binary',fileId:file.id}}),[],[],options)).status).toBe(200);expect(sent!).toEqual(Buffer.from([0,255,1,2]));expect((await HttpExecutor.execute(request(target.url,{method:'POST',body:{mode:'form-data',formData:[{key:'upload',value:'',fileId:file.id},{key:'a',value:'1'},{key:'a',value:'2'}]}}),[],[],options)).status).toBe(200);expect(sent!.includes(Buffer.from([0,255,1,2]))).toBe(true);expect(sent!.toString()).toContain('filename="chosen.bin"');expect((await HttpExecutor.execute(request(target.url,{method:'POST',body:{mode:'binary',fileId:'/etc/passwd'}}),[],[],options)).transportAttempted).toBe(false);}finally{await store.close();await target.stop();}
 });
 it('bounds streamed selected file storage and cleans cancelled/incomplete selections',async()=>{
  const store=new SelectedFileStore(4,2);await expect(store.addStream(Readable.from([Buffer.alloc(3),Buffer.alloc(3)]))).rejects.toThrow(/limit/);const selected=await store.add(Buffer.alloc(4));expect((await store.resolve(selected.id)).size).toBe(4);await store.remove(selected.id);const controller=new AbortController();controller.abort();await expect(store.addStream(Readable.from([Buffer.alloc(1)]),'x','a',controller.signal)).rejects.toThrow();await store.close();
 });
 it('retains a bounded preview and a byte-exact artifact, counts decoded gzip bytes, and cancels downloads',async()=>{
  const payload=Buffer.alloc(20000,97);const target=await fixture((req,res)=>{res.setHeader('content-type','text/plain');res.setHeader('content-encoding','gzip');res.end(gzipSync(payload));});const artifacts=new ResponseArtifactStore();
  try{const progress:number[]=[];const result=await HttpExecutor.execute(request(target.url),[],[],{artifactStore:artifacts,previewBytes:32,onProgress:p=>{if(p.phase==='download')progress.push(p.bytes);}});expect(result.sizeBytes).toBe(payload.length);expect(result.body.length).toBe(32);expect(result.previewTruncated).toBe(true);const chunks=[];for await(const c of artifacts.get(result.artifactId!).open())chunks.push(c);expect(Buffer.concat(chunks)).toEqual(payload);expect(progress.at(-1)).toBe(payload.length);expect((await HttpExecutor.execute(request(target.url,{maxResponseBytes:100}))).error?.code).toBe('ERR_RESPONSE_LIMIT');const abort=new AbortController();const cancelled=await HttpExecutor.execute(request(target.url),[],[],{signal:abort.signal,onResponseChunk:()=>abort.abort()});expect(cancelled.error?.code).toBe('ERR_ABORTED');}finally{await artifacts.close();await target.stop();}
 });
 it('resolves embedded credentials after scripts and binds origin; keeps refs in variables and redacts logs',async()=>{
  let seen:any;const target=await fixture(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);seen={headers:req.headers,url:req.url,body:Buffer.concat(chunks).toString()};res.end('super-secret-value');});const redactor=new SecretRedactor();const calls:string[][]=[];
  try{const result=await HttpExecutor.execute(request(target.url,{method:'POST',headers:[{key:'Authorization',value:'Bearer {{token}}'}],queryParams:[{key:'k',value:'{{token}}'}],body:{mode:'raw-json',raw:'{"token":"{{token}}"}'},preRequestScript:'pm.environment.set("token","{{secret:00000000-0000-4000-8000-000000000001}}");',testScript:'console.log(pm.response.text());'}),[],[],{secrets:redactor,resolveCredential:async(ref,origin)=>{calls.push([ref,origin]);return 'super-secret-value';}});expect(result.status).toBe(200);expect(seen.headers.authorization).toBe('Bearer super-secret-value');expect(seen.url).toContain('k=super-secret-value');expect(seen.body).toContain('super-secret-value');expect(calls.every(c=>c[1]===target.url)).toBe(true);expect(result.updatedEnvironment?.token).toBe('{{secret:00000000-0000-4000-8000-000000000001}}');expect(result.logs?.join('')).not.toContain('super-secret-value');expect((await HttpExecutor.execute(request(target.url+'/{{secret:00000000-0000-4000-8000-000000000001}}'),[],[],{resolveCredential:async()=>{throw new Error('must not resolve');}})).transportAttempted).toBe(false);}finally{await target.stop();}
 });
 it('does not forward resolved headers or credential bodies to a different origin',async()=>{
  let seen='';const second=await fixture((req,res)=>{seen=String(req.headers['x-secret']||'');res.end('ok');});const first=await fixture((req,res)=>{res.writeHead(req.url==='/body'?307:302,{location:second.url});res.end();});
  try{const options={resolveCredential:async()=> 'redirect-secret-value'};expect((await HttpExecutor.execute(request(first.url,{headers:[{key:'X-Secret',value:'{{secret:00000000-0000-4000-8000-000000000001}}'}]}),[],[],options)).status).toBe(200);expect(seen).toBe('');expect((await HttpExecutor.execute(request(first.url+'/body',{method:'POST',body:{mode:'raw-text',raw:'{{secret:00000000-0000-4000-8000-000000000001}}'}}),[],[],options)).status).toBe(0);}finally{await first.stop();await second.stop();}
 });
 it('edits and clears scoped cookies and persists only through explicit backend',async()=>{
  let saved:string|undefined;const manager=new CookieManager({load:async()=>saved,save:async v=>{saved=v;},clear:async()=>{saved=undefined;}});await manager.set('https://example.com/','a=1; Secure; HttpOnly; Path=/');expect((await manager.list('https://example.com/'))[0].value).toBe('1');await manager.save();const restored=new CookieManager(manager.backend);await restored.load();expect((await restored.list('https://example.com/'))[0].httpOnly).toBe(true);await restored.clear('https://example.com/');expect(await restored.list('https://example.com/')).toEqual([]);await restored.clearPersistence();expect(saved).toBeUndefined();await expect(new CookieManager().save()).rejects.toThrow(/unavailable/);
 });
 it('verifies TLS by default and supports explicit CA plus origin-bound mTLS private keys',async()=>{
  const pem=(name:string)=>readFileSync(new URL('./files/tls/'+name,import.meta.url),'utf8');
  const server=https.createServer({key:pem('server-key.pem'),cert:pem('server.pem'),ca:pem('ca.pem'),requestCert:true,rejectUnauthorized:true},(_req,res)=>res.end('mutual TLS'));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`https://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  try{expect((await HttpExecutor.execute(request(url))).status).toBe(0);expect((await HttpExecutor.execute(request(url,{tls:{ca:pem('ca.pem')}}))).status).toBe(0);const origins:string[]=[];const result=await HttpExecutor.execute(request(url,{tls:{ca:pem('ca.pem'),cert:pem('client.pem'),keyRef:'client-key'}}),[],[],{resolveCredential:async(ref,origin)=>{expect(ref).toBe('client-key');origins.push(origin);return pem('client-key.pem');}});expect(result.status).toBe(200);expect(result.body).toBe('mutual TLS');expect(origins).toEqual([url]);}finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('cancels before headers and during upload, enforcing the overall deadline',async()=>{
  const target=await fixture((req,res)=>{if(req.url==='/slow')return;req.resume();req.on('end',()=>res.end('ok'));});
  try{const abort=new AbortController();const pending=HttpExecutor.execute(request(target.url+'/slow'),[],[],{signal:abort.signal});setTimeout(()=>abort.abort(),20);expect((await pending).error?.code).toBe('ERR_ABORTED');expect((await HttpExecutor.execute(request(target.url+'/slow',{timeoutMs:20}))).error?.code).toBe('ETIMEDOUT');const store=new SelectedFileStore();const selected=await store.add(Buffer.alloc(1024*1024));const uploadAbort=new AbortController();const result=await HttpExecutor.execute(request(target.url,{method:'POST',body:{mode:'binary',fileId:selected.id}}),[],[],{resolveFile:id=>store.resolve(id),signal:uploadAbort.signal,onProgress:p=>{if(p.phase==='upload')uploadAbort.abort();}});expect(result.error?.code).toBe('ERR_ABORTED');await store.close();}finally{await target.stop();}
 });

 it('rejects unsafe TLS overrides, framing ambiguities and credentials in structural fields before sending',async()=>{
  let count=0;const target=await fixture((_req,res)=>{count++;res.end('ok');});
  try{
    for(const headers of [[{key:'Content-Length',value:'3'}],[{key:'Transfer-Encoding',value:'chunked'}],[{key:'Host',value:'other.invalid'}],[{key:'Authorization',value:'a'},{key:'authorization',value:'b'}],[{key:'{{secret:00000000-0000-4000-8000-000000000001}}',value:'x'}]])expect((await HttpExecutor.execute(request(target.url,{headers}))).transportAttempted).toBe(false);
    expect((await HttpExecutor.execute(request(target.url,{queryParams:[{key:'{{secret:00000000-0000-4000-8000-000000000001}}',value:'x'}]}))).transportAttempted).toBe(false);
    expect((await HttpExecutor.execute(request(target.url,{tls:{rejectUnauthorized:false} as any}))).transportAttempted).toBe(false);
    expect(count).toBe(0);
  }finally{await target.stop();}
 });
 it('blocks workbench origins on initial, redirect and script child hops',async()=>{
  let hits=0;const forbidden=await fixture((_req,res)=>{hits++;res.end('private');});const target=await fixture((_req,res)=>{res.writeHead(302,{Location:forbidden.url});res.end();});const options={forbiddenOrigins:[forbidden.url]};
  try{expect((await HttpExecutor.execute(request(forbidden.url),[],[],options)).transportAttempted).toBe(false);expect((await HttpExecutor.execute(request(target.url),[],[],options)).status).toBe(0);const child=await HttpExecutor.execute(request(target.url,{preRequestScript:`await pm.sendRequest("${forbidden.url}")`}),[],[],options);expect(child.status).toBe(0);expect(hits).toBe(0);}finally{await target.stop();await forbidden.stop();}
 });

 it('gives response scripts the complete bounded body while keeping the published preview small',async()=>{
  const payload='x'.repeat(20000);const target=await fixture((_req,res)=>{res.setHeader('Content-Type','text/plain');res.end(payload);});const store=new ResponseArtifactStore();
  try{const result=await HttpExecutor.execute(request(target.url,{testScript:'pm.test("whole body",()=>pm.expect(pm.response.text().length).to.equal(20000));'}),[],[],{artifactStore:store,previewBytes:10});expect(result.body).toHaveLength(10);expect(result.testResults?.[0].passed).toBe(true);}finally{await store.close();await target.stop();}
 });
 it('handles bodyless HEAD responses with encoding headers without invoking a decoder',async()=>{
  const target=await fixture((_req,res)=>{res.setHeader('Content-Encoding','gzip');res.end();});try{const response=await HttpExecutor.execute(request(target.url,{method:'HEAD'}));expect(response.status).toBe(200);expect(response.sizeBytes).toBe(0);}finally{await target.stop();}
 });

 it('enforces deadline while async credential resolvers or response consumers are stalled',async()=>{
  const never=()=>new Promise<never>(()=>{});const target=await fixture((_req,res)=>res.end('ok'));
  try{const credentials=await HttpExecutor.execute(request(target.url,{timeoutMs:20,headers:[{key:'X-Key',value:'{{secret:00000000-0000-4000-8000-000000000001}}'}]}),[],[],{resolveCredential:never});expect(credentials.error?.code).toBe('ETIMEDOUT');expect(credentials.transportAttempted).toBe(false);const consumer=await HttpExecutor.execute(request(target.url,{timeoutMs:20}),[],[],{onResponseChunk:never});expect(consumer.error?.code).toBe('ETIMEDOUT');}finally{await target.stop();}
 });

});
