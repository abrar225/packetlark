// Opt-in native integration check: disposable namespace and temp metadata only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CredentialStore} from '../dist/core/security/CredentialStore.js';
if(process.argv[2]==='--read'){
 const store=new CredentialStore({workspaceId:process.argv[3],metadataPath:process.argv[4]});
 const value=await store.resolve(process.argv[5],'https://fixture.invalid');
 assert.equal(value,process.env.PACKETLARK_P2_FIXTURE_VALUE);console.log('Native vault restart resolution PASS');
}else{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'packetlark-native-vault-'));
 const workspaceId='p2-native-fixture-'+randomUUID(),metadataPath=path.join(root,'private','bindings.json'),value=randomUUID()+randomUUID();
 const store=new CredentialStore({workspaceId,metadataPath});let entry;
 try{
  entry=await store.create({label:'Disposable P2 native integration',value,origins:['https://fixture.invalid'],storage:'keychain'});
  assert.equal(await store.resolve(entry.reference,'https://fixture.invalid'),value);
  await assert.rejects(store.resolve(entry.reference,'https://foreign.invalid'));
  assert.ok(!fs.readFileSync(metadataPath,'utf8').includes(value));
  const restarted=spawnSync(process.execPath,[process.argv[1],'--read',workspaceId,metadataPath,entry.reference],{encoding:'utf8',timeout:20000,env:{...process.env,PACKETLARK_P2_FIXTURE_VALUE:value}});
  assert.equal(restarted.status,0,'Native credential failed across process restart');
  await store.delete(entry.id);entry=undefined;assert.deepEqual(await store.list(),[]);
  const result={verdict:'PASS',timestamp:new Date().toISOString(),platform:process.platform,os:os.release(),arch:process.arch,node:process.version,provider:'@napi-rs/keyring 2.1.2',cases:['native create/read','unapproved origin refused','metadata excludes value','independent process restart resolves reference','native delete and metadata cleanup'],limitations:['Only current OS tested; Windows persistence unavailable pending private metadata ACLs.'],secretValuesLogged:false};
  fs.writeFileSync(new URL('../docs/verification/P2_NATIVE_VAULT.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{if(entry)await store.delete(entry.id);fs.rmSync(root,{recursive:true,force:true});}
}
