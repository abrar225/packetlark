import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
interface Entry {size:number;complete:boolean;removed:boolean;ready:Promise<FileHandle>;queue:Promise<void>;readers:Set<ReadStream>;removing?:Promise<void>;}
/** Session-only raw response bytes. IDs never expose filesystem paths. */
export class ResponseArtifactStore {
  #directory?:Promise<string>;
  #path?:string;
  #entries=new Map<string,Entry>();
  #bytes=0;
  #closed=false;
  #closing?:Promise<void>;
  constructor(readonly maxBytes=100*1024*1024,readonly maxArtifacts=32){}
  get stats(){return {bytes:this.#bytes,count:this.#entries.size,availableBytes:Math.max(0,this.maxBytes-this.#bytes),availableCount:Math.max(0,this.maxArtifacts-this.#entries.size)};}
  #serialize<T>(entry:Entry,work:()=>Promise<T>):Promise<T>{const task=entry.queue.then(work);entry.queue=task.then(()=>{},()=>{});return task;}
  async create(){
    if(this.#closed||this.#entries.size>=this.maxArtifacts)throw new Error('Response artifact count exceeded');
    const id=randomUUID();
    this.#directory??=mkdtemp(join(tmpdir(),'packetlark-responses-')).then(path=>{this.#path=path;return path;});
    const entry:Entry={size:0,complete:false,removed:false,ready:this.#directory.then(directory=>open(join(directory,id),'wx',0o600)),queue:Promise.resolve(),readers:new Set()};
    this.#entries.set(id,entry);
    try{await entry.ready;if(this.#closed||entry.removed)throw new Error('Artifact store closed');}
    catch(error){await this.#remove(id,entry);throw error;}
    return {
      id,
      append:(bytes:Uint8Array)=>this.#serialize(entry,async()=>{
        if(entry.complete||entry.removed||this.#closed)throw new Error('Artifact closed');
        if(this.#bytes+bytes.length>this.maxBytes)throw new Error('Response artifact byte budget exceeded');
        this.#bytes+=bytes.length;entry.size+=bytes.length;await (await entry.ready).writeFile(bytes);
      }),
      complete:()=>this.#serialize(entry,async()=>{
        if(entry.removed||this.#closed)throw new Error('Artifact closed');
        if(!entry.complete){await (await entry.ready).close();entry.complete=true;}
        return id;
      }),
      abort:()=>this.#remove(id,entry),
    };
  }
  get(id:string){
    const entry=this.#entries.get(id);if(!entry?.complete||entry.removed||this.#closed)throw new Error('Response artifact unavailable');
    return {id,size:entry.size,open:()=>{
      if(entry.removed||this.#closed)throw new Error('Response artifact unavailable');
      const stream=createReadStream(join(this.#path!,id));entry.readers.add(stream);stream.once('close',()=>entry.readers.delete(stream));return stream;
    }};
  }
  #remove(id:string,entry:Entry):Promise<void>{
    if(entry.removing)return entry.removing;
    entry.removed=true;
    entry.removing=this.#serialize(entry,async()=>{
      const file=await entry.ready.catch(()=>undefined);await file?.close();
      await Promise.all([...entry.readers].map(stream=>new Promise<void>(resolve=>{stream.once('close',resolve);stream.destroy();})));
      if(this.#directory)await rm(join(await this.#directory,id),{force:true});
      this.#bytes-=entry.size;entry.size=0;this.#entries.delete(id);
    });return entry.removing;
  }
  async remove(id:string){const entry=this.#entries.get(id);if(entry)await this.#remove(id,entry);}
  close():Promise<void>{
    if(this.#closing)return this.#closing;
    this.#closed=true;
    this.#closing=(async()=>{
      await Promise.all([...this.#entries].map(([id,entry])=>this.#remove(id,entry)));
      if(this.#directory)await rm(await this.#directory,{recursive:true,force:true});
    })();return this.#closing;
  }
}
