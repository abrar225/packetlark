// Validate the recorded P2 acceptance snapshot. Later phases may intentionally
// change its source hashes; preserve this evidence as a historical phase record.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
try{
 const gate=read('docs/verification/P2_ACCEPTANCE.json');assert.equal(gate.verdict,'PASS');assert.equal(gate.phase,'P2');
 const tests=read(gate.tests.file);assert.equal(tests.success,true);assert.equal(tests.numFailedTests,0);assert.equal(tests.numPassedTests,gate.tests.passed);assert.equal(tests.numTotalTests,gate.tests.passed);assert.equal(hash(gate.tests.file),gate.tests.sha256);
 let cases=0;for(const item of gate.browser){const evidence=read(item.file);assert.equal(evidence.verdict,'PASS',item.file);const count=Array.isArray(evidence.cases)?evidence.cases.length:typeof evidence.cases==='number'?evidence.cases:evidence.results.reduce((n,r)=>{assert.equal(r.verdict,'PASS');return n+r.cases.length;},0);assert.equal(count,item.cases,item.file);assert.equal(hash(item.file),item.sha256);cases+=count;}
 assert.equal(cases,gate.browser_case_count);const native=read(gate.native.file);assert.equal(native.verdict,'PASS');assert.equal(native.platform,'darwin');assert.equal(hash(gate.native.file),gate.native.sha256);
 for(const command of gate.commands)assert.equal(command.exit_code,0,command.command);
 for(const [file,sha] of Object.entries(gate.source_sha256))assert.equal(hash(file),sha,'Source changed after P2 evidence: '+file);
 const tracker=read('docs/roadmap/task-tracker.json');assert.equal(tracker.phases.find(p=>p.id==='P2').status,'done');assert.equal(tracker.tasks.filter(t=>t.phase==='P2'&&t.status==='done').length,12);
 console.log(`P2: 12 tasks; ${gate.tests.passed} tests; ${cases} browser cases; native macOS restart; package/extension checks. Cross-platform limitations remain explicit.`);console.log('VERDICT: PASS');
}catch(error){console.error('VERDICT: FAIL -- '+error.message);process.exitCode=1;}
