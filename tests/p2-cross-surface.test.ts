import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CollectionRunner,reportWithoutBodies,junitReport} from '../src/core/runner/CollectionRunner.js';
import {createMcpServer} from '../src/integrations/mcp.js';
import {main} from '../src/cli.js';
import {SecretRedactor} from '../src/core/security/SecretRedactor.js';
import type {ApiCollection,HttpRequest} from '../src/core/models/types.js';
const req=(url:string,patch:Partial<HttpRequest>={}):HttpRequest=>({id:'probe',url,method:'POST',headers:[],queryParams:[],auth:{type:'none'},body:{mode:'raw-json',raw:'{"amount":1}',schema:{type:'object',required:['amount'],properties:{amount:{type:'integer'}},additionalProperties:false}},...patch});
const collection=(request:HttpRequest):ApiCollection=>({id:'demo',name:'Demo',schemaVersion:'1',variables:[],items:[{id:'probe',name:'Probe',request}]});
async function target(){let hits=0;let header='';const server=http.createServer((req,res)=>{hits++;header=String(req.headers.authorization||'');req.resume();req.on('end',()=>{res.setHeader('content-type','text/plain');res.end(header||'ok');});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${(server.address() as any).port}`,get hits(){return hits;},get header(){return header;},close:()=>new Promise<void>(r=>server.close(()=>r()))};}
describe('P2 headless execution parity',()=>{
 it('runner validates schemas without a workspace context and stops invalid syntax/schema before network',async()=>{
  const server=await target();try{expect((await CollectionRunner.run(collection(req(server.url)))).status).toBe('passed');for(const raw of ['{bad','{"amount":"bad"}']){const response=await CollectionRunner.run(collection(req(server.url,{body:{...req(server.url).body,raw}})));expect(response.status).toBe('failed');expect(response.executions[0].response.transportAttempted).toBe(false);}expect(server.hits).toBe(1);}finally{await server.close();}
 });
 it('runner combines security hooks and seeded redactor without leaking resolved refs to JSON/JUnit',async()=>{
  const server=await target();const secrets=new SecretRedactor();secrets.add('seeded-sensitive-value');
  try{const result=await CollectionRunner.run(collection(req(server.url,{headers:[{key:'Authorization',value:'Bearer {{token}}'}],testScript:'pm.test(pm.response.text(),()=>pm.expect(1).to.equal(2));'})),{environment:{id:'env',name:'env',values:[{key:'token',value:'{{secret:00000000-0000-4000-8000-000000000001}}'}]},executionOptions:{secrets,resolveCredential:async(id,origin)=>{expect(id).toBe('00000000-0000-4000-8000-000000000001');expect(origin).toBe(server.url);return 'resolved-sensitive-value';}}});expect(server.header).toBe('Bearer resolved-sensitive-value');expect(result.environment.values.find(v=>v.key==='token')?.value).toBe('{{secret:00000000-0000-4000-8000-000000000001}}');for(const output of [JSON.stringify(reportWithoutBodies(result)),junitReport(result)]){expect(output).not.toContain('resolved-sensitive-value');expect(output).not.toContain('seeded-sensitive-value');}}finally{await server.close();}
 });
 it('CLI accepts run --workspace and validates schema while keeping workspace untouched for ordinary execution',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rea-p2-cli-'));const server=await target();const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  try{const file=path.join(root,'collection.json');await writeFile(file,JSON.stringify(collection(req(server.url))));expect(await main(['run',file,'--workspace',root,'--reporter','json'])).toBe(0);expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).summary.errors).toBe(0);await expect(access(path.join(root,'.rea-api'))).rejects.toThrow();await writeFile(file,JSON.stringify(collection(req(server.url,{body:{...req(server.url).body,raw:'{"amount":"bad"}'}}))));expect(await main(['run',file,'--workspace',root,'--reporter','json'])).toBe(1);expect(server.hits).toBe(1);}finally{log.mockRestore();await server.close();await rm(root,{recursive:true,force:true});}
 });
 it('MCP validates JSON schemas and supports ordered headers without a writable workspace',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rea-p2-mcp-'));const server=await target();const mcp=createMcpServer(root),client=new Client({name:'p2',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{await mcp.connect(b);await client.connect(a);const invoke=(body:string)=>client.callTool({name:'send_request',arguments:{url:server.url,method:'POST',body,bodyMode:'raw-json',schema:req(server.url).body.schema,headers:[{key:'X-Order',value:'a'},{key:'X-Order',value:'b'}]}});expect((await invoke('{"amount":1}')).isError).toBe(false);expect((await invoke('{"amount":"bad"}')).isError).toBe(true);expect(server.hits).toBe(1);await expect(access(path.join(root,'.rea-api'))).rejects.toThrow();}finally{await client.close();await mcp.close();await server.close();await rm(root,{recursive:true,force:true});}
 });
 it('MCP collection runs apply schema validation before sending',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'rea-p2-mcp-run-'));const server=await target();await mkdir(path.join(root,'.rea-api','collections'),{recursive:true});await writeFile(path.join(root,'.rea-api','collections','demo.json'),JSON.stringify(collection(req(server.url,{body:{...req(server.url).body,raw:'{"amount":false}'}}))));const mcp=createMcpServer(root),client=new Client({name:'p2-run',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{await mcp.connect(b);await client.connect(a);const result=await client.callTool({name:'run_collection',arguments:{collectionId:'demo'}});expect(result.isError).toBe(true);expect(JSON.parse((result.content as any)[0].text).summary.errors).toBe(1);expect(server.hits).toBe(0);}finally{await client.close();await mcp.close();await server.close();await rm(root,{recursive:true,force:true});}
 });
 it('CLI and MCP share injected-provider origin binding and redact resolved credentials from reports',async()=>{
  const {WorkspaceExecution}=await import('../src/core/engine/WorkspaceExecution.js');
  const secret='cross-surface-resolved-credential';const values=new Map<string,string>();
  const root=await mkdtemp(path.join(tmpdir(),'rea-p2-refs-'));const server=await target();
  const providerContext=new WorkspaceExecution(path.join(root,'.rea-api'),{credentialProvider:{get:async(n,id)=>{const value=values.get(n+id);if(!value)throw new Error('Missing fixture credential');return value;},set:async(n,id,value)=>{values.set(n+id,value);},delete:async(n,id)=>{values.delete(n+id);}}});
  const credential=await providerContext.credentials.create({label:'Fixture',value:secret,origins:[server.url],storage:'keychain'});
  const original=WorkspaceExecution.prototype.options;
  const hook=vi.spyOn(WorkspaceExecution.prototype,'options').mockImplementation(()=>original.call(providerContext));
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  const mcp=createMcpServer(root),client=new Client({name:'p2-ref',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{const file=path.join(root,'collection.json');await writeFile(file,JSON.stringify(collection(req(server.url,{headers:[{key:'Authorization',value:'Bearer '+credential.reference}],testScript:'pm.test(pm.response.text(),()=>pm.expect(1).to.equal(2));'}))));expect(await main(['run',file,'--workspace',root,'--reporter','json'])).toBe(1);expect(server.header).toBe('Bearer '+secret);expect(String(log.mock.calls.at(-1)?.[0])).not.toContain(secret);await mcp.connect(b);await client.connect(a);const result=await client.callTool({name:'send_request',arguments:{url:server.url,method:'POST',headers:{Authorization:'Bearer '+credential.reference},body:'x',includeBody:true}});expect(result.isError).toBe(false);expect(server.header).toBe('Bearer '+secret);expect(JSON.stringify(result)).not.toContain(secret);
    const before=server.hits;const missing='{{secret:00000000-0000-4000-8000-000000000000}}';
    const missingResult=await client.callTool({name:'send_request',arguments:{url:server.url,headers:{Authorization:'Bearer '+missing}}});expect(missingResult.isError).toBe(true);expect(server.hits).toBe(before);
    await writeFile(file,JSON.stringify(collection(req(server.url,{headers:[{key:'Authorization',value:'Bearer '+missing}]}))));expect(await main(['run',file,'--workspace',root,'--reporter','json'])).toBe(1);expect(server.hits).toBe(before);expect(String(log.mock.calls.at(-1)?.[0])).not.toContain(secret);
    await expect(providerContext.credentials.resolve(credential.id,'https://unapproved.invalid')).rejects.toThrow();expect(await readFile(path.join(root,'.rea-api','private-credentials','bindings-v1.json'),'utf8')).not.toContain(secret);}finally{hook.mockRestore();log.mockRestore();await client.close();await mcp.close();await providerContext.close();await server.close();await rm(root,{recursive:true,force:true});}
 });

 it('keeps CLI argument validation strict while allowing run workspace selection',async()=>{
  await expect(main(['run','unused.json','--port','42'])).rejects.toThrow(/not valid/);
  await expect(main(['run','unused.json','--workspace'])).rejects.toThrow(/Missing value/);
  await expect(main(['run','unused.json','--unknown'])).rejects.toThrow(/Unexpected argument/);
 });

});
