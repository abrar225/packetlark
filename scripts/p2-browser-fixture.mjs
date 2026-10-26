// Disposable P2 peer/provider/Studio. No live workspace or OS keychain access.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioServer } from '../dist/server/StudioServer.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rea-p2-browser-'));
const filePath=path.join(root,'chosen.bin'); fs.writeFileSync(filePath,Buffer.from([0,1,255,127,65,66,10]));
const tokens=new Map();
const peer=http.createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/authorize'){const callback=new URL(url.searchParams.get('redirect_uri'));callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','fixture-only-code');res.writeHead(302,{Location:callback.href});res.end();return;}
 if(url.pathname==='/token'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({access_token:'fixture-only-oauth-token',token_type:'Bearer',expires_in:3600,refresh_token:'fixture-only-refresh-token'}));return;}
 if(url.pathname==='/revoke'){res.end();return;}
 if(url.pathname==='/binary'){res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.alloc(600*1024,0xab));return;}
 res.setHeader('Content-Type','application/json');const reply=()=>res.end(JSON.stringify({owner:req.url,url:req.url,method:req.method,headers:req.headers,headerEntries:req.rawHeaders,body:body.toString(),bodyBase64:body.toString('base64'),size:body.length}));
 if(url.pathname.startsWith('/slow'))setTimeout(reply,800);else reply();
});
await new Promise(r=>peer.listen(0,'127.0.0.1',r));
const targetUrl=`http://127.0.0.1:${peer.address().port}`;
const studio=new StudioServer(0,0,root,{credentialProvider:{get:async(n,id)=>{if(!tokens.has(n+id))throw Error('Unavailable fixture entry');return tokens.get(n+id);},set:async(n,id,value)=>{tokens.set(n+id,value);},delete:async(n,id)=>{tokens.delete(n+id);}},allowInsecureOAuthForTests:true});
const baseUrl=`http://127.0.0.1:${await studio.start()}`;
const req=(id,name,url)=>({id,name,url:targetUrl+url,method:'GET',headers:[],queryParams:[],body:{mode:'none'},auth:{type:'none'}});
await fetch(baseUrl+'/api/collections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'race_fixture',name:'Race fixture',variables:[],items:[{id:'race_a',name:'Race A',request:req('race_a','Race A','/slow-a')},{id:'race_b',name:'Race B',request:req('race_b','Race B','/fast-b')}]})});
console.log(JSON.stringify({baseUrl,targetUrl,filePath,workspace:root,pid:process.pid}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;await studio.stop();peer.closeAllConnections();await new Promise(r=>peer.close(r));fs.rmSync(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
