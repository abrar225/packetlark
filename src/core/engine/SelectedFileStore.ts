import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface SelectedFile { id:string;name:string;size:number;contentType:string;open():ReadStream; }
/** Accepts explicit upload bytes only. Imported paths are never opened. */
export class SelectedFileStore {
  #directory?:Promise<string>;
  #files=new Map<string,SelectedFile>();
  #pending=new Map<AbortController,Promise<unknown>>();
  #readers=new Set<ReadStream>();
  #bytes=0;
  #closed=false;
  #closing?:Promise<void>;
  constructor(readonly maxBytes=50*1024*1024,readonly maxFiles=32){}
  get stats(){return {bytes:this.#bytes,count:this.#files.size,pending:this.#pending.size,availableBytes:Math.max(0,this.maxBytes-this.#bytes),availableCount:Math.max(0,this.maxFiles-this.#files.size-this.#pending.size)};}
  async add(bytes:Uint8Array,name='upload.bin',contentType='application/octet-stream') {
    return this.addStream(Readable.from([bytes]),name,contentType);
  }
  addStream(source:AsyncIterable<Uint8Array>,name='upload.bin',contentType='application/octet-stream',externalSignal?:AbortSignal):Promise<Omit<SelectedFile,'open'>> {
    if(externalSignal?.aborted)return Promise.reject(externalSignal.reason);
    if(this.#closed||!this.stats.availableCount)return Promise.reject(new Error('Selected file store limit exceeded'));
    const controller=new AbortController();
    const signal=externalSignal?AbortSignal.any([externalSignal,controller.signal]):controller.signal;
    const task=this.#write(source,name,contentType,signal).finally(()=>this.#pending.delete(controller));
    this.#pending.set(controller,task);
    return task;
  }
  async #write(source:AsyncIterable<Uint8Array>,name:string,contentType:string,signal:AbortSignal):Promise<Omit<SelectedFile,'open'>> {
    const id=randomUUID();let size=0;let path:string|undefined;let handle:Awaited<ReturnType<typeof open>>|undefined;
    const iterator=source[Symbol.asyncIterator]();
    let rejectAbort:(reason:unknown)=>void;
    const cancelled=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    // The race observes cancellation even when an arbitrary iterator never produces another chunk.
    const abort=()=>{rejectAbort(signal.reason);if('destroy' in source && typeof source.destroy==='function')source.destroy();};
    signal.addEventListener('abort',abort,{once:true});
    // Avoid an unobserved rejection while the file is being opened.
    void cancelled.catch(()=>{});
    try {
      signal.throwIfAborted();this.#directory??=mkdtemp(join(tmpdir(),'rea-selected-'));
      path=join(await this.#directory,id);handle=await open(path,'wx',0o600);
      while(true){
        signal.throwIfAborted();const next=await Promise.race([iterator.next(),cancelled]);
        signal.throwIfAborted();if(next.done)break;const chunk=next.value;
        if(this.#bytes+chunk.length>this.maxBytes)throw new Error('Selected file store byte limit exceeded');
        size+=chunk.length;this.#bytes+=chunk.length;await handle.writeFile(chunk);
      }
      signal.throwIfAborted();await handle.close();handle=undefined;signal.throwIfAborted();
      const file:SelectedFile={id,name:basename(name).replace(/[\r\n"\\]/g,'_').slice(0,200)||'upload.bin',size,contentType:contentType.replace(/[\r\n]/g,'').slice(0,200),open:()=>{
        if(this.#closed||!this.#files.has(id))throw new Error('Selected file unavailable');
        const stream=createReadStream(path!);this.#readers.add(stream);stream.once('close',()=>this.#readers.delete(stream));return stream;
      }};
      this.#files.set(id,file);const {open:_,...meta}=file;return meta;
    }catch(error){this.#bytes-=size;await handle?.close();if(path)await rm(path,{force:true});throw error;}
    finally{signal.removeEventListener('abort',abort);void iterator.return?.().catch(()=>{});}
  }
  async resolve(id:string):Promise<SelectedFile>{const file=this.#files.get(id);if(!file)throw new Error('Selected file is unavailable; select it again');return file;}
  async remove(id:string){const file=this.#files.get(id);if(!file)return;this.#files.delete(id);this.#bytes-=file.size;await rm(join(await this.#directory!,id),{force:true});}
  close():Promise<void>{
    if(this.#closing)return this.#closing;
    this.#closed=true;for(const controller of this.#pending.keys())controller.abort(new Error('Selected file store closed'));
    this.#closing=(async()=>{
      await Promise.allSettled([...this.#pending.values()]);
      await Promise.all([...this.#readers].map(stream=>new Promise<void>(resolve=>{stream.once('close',resolve);stream.destroy();})));
      if(this.#directory)await rm(await this.#directory,{recursive:true,force:true});
      this.#files.clear();this.#bytes=0;
    })();return this.#closing;
  }
}
