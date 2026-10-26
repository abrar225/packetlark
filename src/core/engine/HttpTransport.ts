import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { BodyBudgetError } from './BodyBudget.js';

/** An ordered multimap. Replacement is explicit; append preserves duplicate wire fields. */
export class OrderedHeaders {
  entries: Array<[string,string]> = [];
  constructor(other?: OrderedHeaders) { this.entries = other ? other.entries.map(([k,v])=>[k,v]) : []; }
  append(k:string,v:string) { http.validateHeaderName(k); http.validateHeaderValue(k,v); this.entries.push([k,v]); }
  set(k:string,v:string) { this.delete(k); this.append(k,v); }
  get(k:string) { return this.entries.find(([n])=>n.toLowerCase()===k.toLowerCase())?.[1] ?? null; }
  has(k:string) { return this.get(k)!==null; }
  delete(k:string) { this.entries=this.entries.filter(([n])=>n.toLowerCase()!==k.toLowerCase()); }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
}
export type Progress = {phase:'upload'|'download';bytes:number;total?:number};
export interface TransportResponse { status:number;statusText:string;headers:OrderedHeaders;headerEntries:Array<[string,string]>;body:Readable;cancel():void; }
export interface TransportOptions {
  method:string;headers:OrderedHeaders;body?:AsyncIterable<Uint8Array>|Uint8Array|string;
  signal:AbortSignal;maxRequestBytes:number;
  tls?:{ca?:string;cert?:string;key?:string;passphrase?:string};
  onProgress?:(progress:Progress)=>void|Promise<void>;
}
/** Node's raw header array preserves duplicates, casing and order on HTTP/1.1. */
export async function sendHttp(url:URL, options:TransportOptions):Promise<TransportResponse> {
  options.signal.throwIfAborted();
  return await new Promise((resolve,reject)=>{
    const raw=options.headers.entries.flat();
    // Host is automatic only with object headers in Node; preserve explicit order otherwise.
    if (!options.headers.has('host')) raw.push('Host',url.host);
    const req=(url.protocol==='https:'?https:http).request(url,{method:options.method,headers:raw,signal:options.signal,...options.tls,rejectUnauthorized:true},(res:IncomingMessage)=>{
      const headers=new OrderedHeaders(); const entries:Array<[string,string]>=[];
      for(let i=0;i<res.rawHeaders.length;i+=2){headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);entries.push([res.rawHeaders[i],res.rawHeaders[i+1]]);}
      let body:Readable=res;
      const encoding=options.method==='HEAD' || res.statusCode===204 || res.statusCode===304 ? undefined : headers.get('content-encoding')?.toLowerCase();
      const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():undefined;
      const abort=()=>{res.destroy(options.signal.reason);decoder?.destroy(options.signal.reason);};
      if(decoder){res.on('error',e=>decoder.destroy(e));body=res.pipe(decoder);}
      options.signal.addEventListener('abort',abort,{once:true});
      body.once('close',()=>options.signal.removeEventListener('abort',abort));
      body.on('error',()=>{});
      resolve({status:res.statusCode||0,statusText:res.statusMessage||'',headers,headerEntries:entries,body,cancel(){res.destroy();decoder?.destroy();}});
    });
    req.on('error',reject);
    void (async()=>{
      let size=0;
      try{
        const source=typeof options.body==='string'||options.body instanceof Uint8Array?[Buffer.from(options.body)]:options.body;
        if(source) for await(const chunk of source){
          options.signal.throwIfAborted(); size+=chunk.length;
          if(size>options.maxRequestBytes)throw new BodyBudgetError('Request body exceeds configured limit','ERR_REQUEST_LIMIT',413);
          if(!req.write(chunk)) await once(req,'drain',{signal:options.signal});
          await options.onProgress?.({phase:'upload',bytes:size});
        }
        req.end();
      }catch(error){req.destroy(error as Error);reject(error);}
    })();
  });
}
