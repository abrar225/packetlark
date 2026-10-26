import {describe,it,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {WorkspaceExecution} from '../src/core/engine/WorkspaceExecution.js';
import {P2Api} from '../src/server/P2Api.js';
describe('P2 secure cookie operation ownership',()=>{
 it.skipIf(process.platform==='win32')('bounds stalled writes, forbids blind retry, serializes later disable and holds native work through close',async()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rea-cookie-lifecycle-'));
  let release!:()=>void,started!:()=>void;const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);const values=new Map<string,string>();
  const context=new WorkspaceExecution(root,{credentialProvider:{get:async(n,id)=>values.get(n+id)!,set:async(n,id,value)=>{started();await gate;values.set(n+id,value);},delete:async(n,id)=>{values.delete(n+id);}}});
  const api=new P2Api(context,'http://127.0.0.1:4040',{assertOwned(){},snapshot:()=>({collections:[],environments:[]}),commit(){}},30);
  const call=(enabled:boolean)=>{const response={writableEnded:false,destroyed:false,writeHead(){},end(){this.writableEnded=true;}};return api.handle({method:'POST'} as any,response as any,new URL('http://127.0.0.1:4040/api/cookies/persistence'),async()=>({enabled,storage:'keychain',consent:true}));};
  try{
   await context.cookies.set('https://fixture.invalid','a=value');
   const first=call(true);const failure=expect(first).rejects.toMatchObject({code:'ERR_COOKIE_PENDING'});await entered;await failure;
   await expect(call(false)).rejects.toMatchObject({code:'ERR_COOKIE_PENDING'});
   let closed=false;const closing=context.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,5));expect(closed).toBe(false);
   release();await closing;
   // Allow the already authorized operation to settle, then apply a newer reviewed choice.
   await new Promise(r=>setTimeout(r,10));await call(false);
   expect(JSON.parse(fs.readFileSync(path.join(root,'private-credentials','cookies-v1.json'),'utf8')).enabled).toBe(false);
  }finally{release();await context.close();fs.rmSync(root,{recursive:true,force:true});}
 });
});
