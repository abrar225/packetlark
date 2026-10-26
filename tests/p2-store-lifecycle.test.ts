import {describe,it,expect,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {stat,access} from 'node:fs/promises';
import path from 'node:path';
import {CookieJar,MemoryCookieStore} from 'tough-cookie';
import {SelectedFileStore} from '../src/core/engine/SelectedFileStore.js';
import {ResponseArtifactStore} from '../src/core/engine/ResponseArtifactStore.js';
import {CookieManager} from '../src/core/engine/CookieManager.js';
const closed=(stream:any)=>new Promise<void>(resolve=>{stream.once('close',resolve);stream.destroy();});
async function bytes(stream:AsyncIterable<Buffer>){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}
describe('P2 private session store lifecycle',()=>{
 it('tracks selected quotas/removal and uses private directory/file permissions',async()=>{
  const store=new SelectedFileStore(8,2);const selected=await store.add(Buffer.alloc(4),'../file.bin');const file=await store.resolve(selected.id);const stream=file.open();const filename=String(stream.path);await closed(stream);
  expect(selected.name).toBe('file.bin');expect(store.stats).toEqual({bytes:4,count:1,pending:0,availableBytes:4,availableCount:1});
  if(process.platform!=='win32'){expect((await stat(filename)).mode&0o777).toBe(0o600);expect((await stat(path.dirname(filename))).mode&0o777).toBe(0o700);}
  await store.remove(selected.id);expect(store.stats.bytes).toBe(0);await expect(access(filename)).rejects.toThrow();await store.close();await expect(access(path.dirname(filename))).rejects.toThrow();
 });
 it('aborts pending selected streams on close, waits cleanup, and never publishes cancelled selections',async()=>{
  const store=new SelectedFileStore(16,3);const completed=await store.add(Buffer.alloc(2));const reader=(await store.resolve(completed.id)).open();const directory=path.dirname(String(reader.path));await closed(reader);
  const source=new PassThrough();const pending=store.addStream(source);const rejection=expect(pending).rejects.toThrow(/closed/);source.write(Buffer.alloc(3));await vi.waitFor(()=>expect(store.stats.bytes).toBe(5));
  const first=store.close(),second=store.close();expect(first).toBe(second);await rejection;await first;expect(store.stats.bytes).toBe(0);expect(store.stats.pending).toBe(0);expect(store.stats.count).toBe(0);await expect(access(directory)).rejects.toThrow();await expect(store.add(Buffer.alloc(1))).rejects.toThrow();
 });
 it('cancels an iterator stalled in next without waiting for its producer and releases all quotas',async()=>{
  const store=new SelectedFileStore(8,1);const controller=new AbortController();let started=false;
  const source={async *[Symbol.asyncIterator](){yield Buffer.alloc(3);started=true;await new Promise(()=>{});}};
  const pending=store.addStream(source,'x','application/octet-stream',controller.signal);const failure=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(started).toBe(true));controller.abort(new Error('cancelled'));await failure;expect(store.stats.bytes).toBe(0);expect(store.stats.pending).toBe(0);expect((await store.add(Buffer.alloc(8))).size).toBe(8);await store.close();
 });
 it('serializes concurrent artifact writes, preserves exact bytes, and reclaims completed storage',async()=>{
  const store=new ResponseArtifactStore(8,2);const writer=await store.create();await Promise.all([writer.append(Buffer.from('abc')),writer.append(Buffer.from('def'))]);const id=await writer.complete();expect(await bytes(store.get(id).open())).toEqual(Buffer.from('abcdef'));expect(store.stats.bytes).toBe(6);
  const reader=store.get(id).open(),filename=String(reader.path);await closed(reader);if(process.platform!=='win32'){expect((await stat(filename)).mode&0o777).toBe(0o600);expect((await stat(path.dirname(filename))).mode&0o777).toBe(0o700);}
  await store.remove(id);expect(store.stats.bytes).toBe(0);expect(store.stats.count).toBe(0);expect(()=>store.get(id)).toThrow();await store.close();await expect(access(path.dirname(filename))).rejects.toThrow();
 });
 it('enforces aggregate concurrent artifact budgets and removes partial writers',async()=>{
  const store=new ResponseArtifactStore(4,2);const [a,b]=await Promise.all([store.create(),store.create()]);await expect(store.create()).rejects.toThrow(/count/);const writes=await Promise.allSettled([a.append(Buffer.alloc(3)),b.append(Buffer.alloc(3))]);expect(writes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(store.stats.bytes).toBe(3);await Promise.all([a.abort(),b.abort()]);expect(store.stats.bytes).toBe(0);expect(store.stats.count).toBe(0);await store.close();
 });
 it('close waits pending artifact creation/writes and prohibits completion after closure',async()=>{
  const store=new ResponseArtifactStore();const writer=await store.create();const append=writer.append(Buffer.alloc(100000));const appendResult=append.catch(()=>{});const closing=store.close();expect(store.close()).toBe(closing);await appendResult;await closing;await expect(writer.complete()).rejects.toThrow(/closed/);expect(()=>store.get(writer.id)).toThrow();expect(store.stats.bytes).toBe(0);expect(store.stats.count).toBe(0);
  const other=new ResponseArtifactStore();const creating=other.create();const rejected=expect(creating).rejects.toThrow(/closed/);await other.close();await rejected;expect(other.stats.count).toBe(0);expect(other.stats.bytes).toBe(0);
 });
});
describe('bounded cookie storage',()=>{
 it('counts UTF8 bytes, rejects oversized sync/async writes, and preserves previous cookies atomically',async()=>{
  const manager=new CookieManager();await manager.set('https://example.com/','valid=ok');await expect(manager.jar.setCookie('large='+ '界'.repeat(22000),'https://example.com/')).rejects.toThrow(/limit/);expect(()=>manager.jar.setCookieSync('large='+ '界'.repeat(22000),'https://example.com/')).toThrow(/limit/);expect((await manager.list('https://example.com/')).map(c=>c.key)).toEqual(['valid']);
 });
 it('supports promise/callback/sync cookie APIs and waits queued writes before secure persistence',async()=>{
  let persisted='';const manager=new CookieManager({load:async()=>persisted,save:async(value)=>{persisted=value;},clear:async()=>{persisted='';}});manager.jar.setCookieSync('sync=1','https://example.com/');await new Promise<void>((resolve,reject)=>manager.jar.setCookie('callback=2','https://example.com/',error=>error?reject(error):resolve()));const pending=manager.jar.setCookie('queued=3','https://example.com/');await manager.save();await pending;expect(JSON.parse(persisted).cookies.map((c:any)=>c.key).sort()).toEqual(['callback','queued','sync']);const restored=new CookieManager(manager.backend);await restored.load();expect((await restored.list('https://example.com/'))).toHaveLength(3);await Promise.all([restored.set('https://example.com/','last=4'),restored.clear(),restored.save()]);expect(JSON.parse(persisted).cookies).toEqual([]);
 });
 it('checks restored/assigned state and rejects aggregate overflow under concurrent writes',async()=>{
  const manager=new CookieManager();const assigned=new CookieJar();assigned.setCookieSync('large='+ '界'.repeat(22000),'https://example.com/');expect(()=>{manager.jar=assigned;}).toThrow(/limit/);
  const large='x'.repeat(33000);const result=await Promise.allSettled([manager.jar.setCookie('one='+large,'https://example.com/'),manager.jar.setCookie('two='+large,'https://example.com/')]);expect(result.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect((await manager.list('https://example.com/'))).toHaveLength(1);
  const saved=JSON.stringify(assigned.serializeSync());const restored=new CookieManager({load:async()=>saved,save:async()=>{},clear:async()=>{}});await expect(restored.load()).rejects.toThrow(/limit/);expect(await restored.list('https://example.com/')).toEqual([]);
 });
 it('supports a callback based asynchronous cookie store',async()=>{
  class AsyncStore extends MemoryCookieStore {constructor(){super();this.synchronous=false;}}
  const manager=new CookieManager();manager.jar=new CookieJar(new AsyncStore());await manager.set('https://example.com/','async=ok');expect((await manager.list('https://example.com/'))[0].value).toBe('ok');await manager.clear();expect(await manager.list('https://example.com/')).toEqual([]);
 });
});
