import { CookieJar } from 'tough-cookie';
/** Implement using an OS credential vault. Plain workspace JSON is not an approved backend. */
export interface SecureCookieBackend {load():Promise<string|undefined>;save(value:string):Promise<void>;clear():Promise<void>;}
interface JarState {tail:Promise<void>;active:number;}
const states=new WeakMap<CookieJar,JarState>();
const check=(value:any)=>{
  if(!Array.isArray(value.cookies)||Buffer.byteLength(JSON.stringify(value),'utf8')>64*1024||value.cookies.length>500)
    throw new Error('Cookie retention limit reached (500 cookies / 64 KiB)');
};
function queued<T>(jar:CookieJar,work:()=>Promise<T>):Promise<T>{
  const state=states.get(jar)!;state.active++;
  const operation=state.tail.then(work);
  state.tail=operation.then(()=>{},()=>{}).finally(()=>{state.active--;});
  return operation;
}
function bounded(jar:CookieJar):CookieJar {
  if(states.has(jar))return jar;
  if(jar.store.synchronous)check(jar.serializeSync());
  const original=jar.setCookie.bind(jar);
  const state:JarState={tail:Promise.resolve(),active:0};states.set(jar,state);
  jar.setCookie=((...args:any[])=>{
    const callback=typeof args.at(-1)==='function'?args.pop():undefined;
    const operation=queued(jar,async()=>{
      const snapshot=await jar.serialize();check(snapshot);
      const candidate=CookieJar.deserializeSync(snapshot);
      await (candidate.setCookie as any)(...args);check(await candidate.serialize());
      return (original as any)(...args);
    });
    if(callback){void operation.then(value=>callback(null,value),error=>callback(error));return;}
    return operation;
  }) as any;
  // Preserve tough-cookie's synchronous API without letting it bypass the quota.
  jar.setCookieSync=((...args:any[])=>{
    if(!jar.store.synchronous||state.active)throw new Error('Cookie writes are pending; use the asynchronous API');
    const candidate=CookieJar.deserializeSync(jar.serializeSync());
    (candidate.setCookieSync as any)(...args);check(candidate.serializeSync());
    let result:any,error:any,called=false;
    (original as any)(...args,(reason:any,value:any)=>{called=true;error=reason;result=value;});
    if(error)throw error;if(!called)throw new Error('Cookie store requires asynchronous API');return result;
  }) as any;
  return jar;
}
export class CookieManager {
  #jar=bounded(new CookieJar());
  #operations:Promise<void>=Promise.resolve();
  get jar(){return this.#jar;}
  set jar(value:CookieJar){this.#jar=bounded(value);}
  constructor(readonly backend?:SecureCookieBackend){}
  #run<T>(work:()=>Promise<T>):Promise<T>{const task=this.#operations.then(work);this.#operations=task.then(()=>{},()=>{});return task;}
  list(url:string){return this.#run(()=>queued(this.jar,async()=>{check(await this.jar.serialize());return (await this.jar.getCookies(url)).map(cookie=>cookie.toJSON());}));}
  set(url:string,cookie:string){return this.#run(async()=>{await this.jar.setCookie(cookie,url);});}
  clear(url?:string){return this.#run(()=>queued(this.jar,async()=>{
    if(!url)await this.jar.removeAllCookies();
    else for(const cookie of await this.jar.getCookies(url))await this.jar.store.removeCookie(cookie.domain!,cookie.path!,cookie.key);
  }));}
  load(){return this.#run(async()=>{
    const value=await this.backend?.load();if(!value)return;
    if(Buffer.byteLength(value,'utf8')>64*1024)throw new Error('Cookie persistence limit exceeded');
    const data=JSON.parse(value);check(data);
    const restored=await CookieJar.deserialize(data);check(await restored.serialize());
    // Drain earlier transport writes before replacing the current jar.
    await states.get(this.jar)!.tail;this.jar=restored;
  });}
  save(){return this.#run(()=>queued(this.jar,async()=>{
    if(!this.backend)throw new Error('Secure cookie persistence unavailable');
    const snapshot=await this.jar.serialize();check(snapshot);await this.backend.save(JSON.stringify(snapshot));
  }));}
  clearPersistence(){return this.#run(async()=>{await this.backend?.clear();});}
}
