import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,copyFile,appendFile,writeFile,readFile,unlink } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ROOT } from '../src/paths.mjs';
import { canonical,captureStrategyVersion,readTradeVersions } from '../src/strategy-version.mjs';
import { writeJson } from '../src/io.mjs';
import { fixture,engineConfig } from './fixtures.mjs';
const temp=()=>mkdtemp(join(tmpdir(),'binance-version-'));
const observerFiles=['src/model-entry.mjs','config/model-execution.json','config/model-research.json',
 'src/pretrained_model.py','scripts/kronos-worker.py','scripts/setup_kronos.py','requirements.model.lock'];
async function copySources(version){
 const root=await temp();
 for(const file of version.sources){await mkdir(dirname(join(root,file.path)),{recursive:true});await copyFile(join(ROOT,file.path),join(root,file.path));}
 return root;
}
test('version is stable across time, excludes auth, changes with source/policy/observed exits',async()=>{
 const f=await fixture(),engine={...engineConfig(f.policy),password:'never-persist-this',minimal_roi:{'0':.03}};
 const base=await captureStrategyVersion({policy:f.policy,engine,now:f.now});
 assert.ok(!JSON.stringify(base).includes('never-persist-this'));
 assert.equal(base.fingerprint,(await captureStrategyVersion({policy:f.policy,engine,now:f.now+1000})).fingerprint);
 assert.notEqual(base.fingerprint,(await captureStrategyVersion({policy:{...f.policy,maxStakeUsdt:'20'},engine})).fingerprint);
 assert.notEqual(base.fingerprint,(await captureStrategyVersion({policy:f.policy,engine:{...engine,minimal_roi:{'0':.01}}})).fingerprint);
 const root=await temp();
 for(const file of base.sources){await mkdir(dirname(join(root,file.path)),{recursive:true});await copyFile(join(ROOT,file.path),join(root,file.path));}
 await appendFile(join(root,'prompts/analyst-active.md'),'\nChanged experiment.');
 assert.notEqual(base.fingerprint,(await captureStrategyVersion({policy:f.policy,engine,root})).fingerprint);
});
test('attribution requires exact tag, snapshot, intact manifest, and entry-time evidence',async()=>{
 const f=await fixture(),local=await temp(),id=createHash('sha256').update(f.snapshot.id).digest('hex').slice(0,32),tag='codex-'+id;
 const record={id,tag,status:'pending',action:'buy',pair:f.proposal.pair,snapshotId:f.snapshot.id,at:new Date(f.now+1000).toISOString()};
 const trade={trade_id:1,pair:record.pair,enter_tag:tag};
 const version=await captureStrategyVersion({policy:f.policy,now:f.now});
 const file=join(local,'runs',f.snapshot.id+'.version.json');await writeJson(file,version);
 assert.equal((await readTradeVersions(local,[trade],[record],'dry-run')).versions[1],version.fingerprint);
 for(const rows of [[{...record,tag:undefined}], [{...record,id:'b'.repeat(32)}], [{...record,at:'invalid'}], [record,record]])
  assert.deepEqual((await readTradeVersions(local,[trade],rows,'dry-run')).versions,{});
 assert.deepEqual((await readTradeVersions(local,[{...trade,enter_tag:undefined}],[{...record,tag:undefined}],'dry-run')).versions,{});
 await writeJson(file,{...version,fingerprint:'0'.repeat(64)});
 assert.equal((await readTradeVersions(local,[trade],[record],'dry-run')).warnings.length,1);
 await writeJson(file,{...version,capturedAt:new Date(f.now+2000).toISOString()});
 assert.deepEqual((await readTradeVersions(local,[trade],[record],'dry-run')).versions,{});
});

test('flow execution survives missing, malformed, changed and stopped observer evidence in both Demo modes',async()=>{
 for(const mode of ['demo','demo-futures']){
  const args={policy:{mode},analyst:{version:1,style:'active'}},base=await captureStrategyVersion(args),root=await copySources(base);
  assert.deepEqual(base.executionScope.excludedObserverSources,observerFiles);
  assert.equal(base.executionScope.entryPolicyVersion,'order-flow-only-v1');
  assert.equal(base.observerProvenance.status,'not_collected');
  assert.equal(base.observerProvenance.modelPinVerified,false);
  assert.equal(base.observerProvenance.usedForEntryDecision,false);
  assert.equal(base.observerProvenance.verificationOwner,'src/model-watchdog.mjs');
  assert.ok(observerFiles.every(path=>!base.sources.some(source=>source.path===path)));
  // The fixture has every execution source, but none of the observer sources.
  assert.equal((await captureStrategyVersion({...args,root})).fingerprint,base.fingerprint);
  for(const file of [...observerFiles,'local/model-research/loaded-model.json','local/model-research/STOP']){
   const path=join(root,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,'invalid observer evidence');
  }
  assert.equal((await captureStrategyVersion({...args,root})).fingerprint,base.fingerprint);
  await appendFile(join(root,'config/model-execution.json'),'\nchanged observer pin');
  assert.equal((await captureStrategyVersion({...args,root})).fingerprint,base.fingerprint);
  await unlink(join(root,'config/model-execution.json'));
  assert.equal((await captureStrategyVersion({...args,root})).fingerprint,base.fingerprint);
 }
});

test('flow manifests still require and detect changes to native protection, flow rules and shared risk helpers',async()=>{
 const args={policy:{mode:'demo'},analyst:{version:1,style:'active'}},base=await captureStrategyVersion(args),root=await copySources(base);
 const required=['src/spot-candidate.mjs','src/spot-candidate-store.mjs','scripts/demo_model_guard.py','scripts/demo_protection.py','scripts/demo_order_flow.py',
  'scripts/demo_flow_exit.py','freqtrade/strategies/RuleExits.py','src/protection.mjs','src/order-flow.mjs',
  'src/bridge.mjs','src/risk.mjs','src/demo-risk.mjs','src/model-pullback.mjs'];
 for(const file of required){
  assert.ok(base.sources.some(source=>source.path===file),file+' must remain in execution scope');
  await appendFile(join(root,file),'\nexecution-source-change');
  assert.notEqual((await captureStrategyVersion({...args,root})).fingerprint,base.fingerprint,file);
  await copyFile(join(ROOT,file),join(root,file));
 }
 for(const file of ['src/spot-candidate.mjs','src/spot-candidate-store.mjs','scripts/demo_model_guard.py']){
  await unlink(join(root,file));
  await assert.rejects(captureStrategyVersion({...args,root}),{code:'ENOENT'});
  await copyFile(join(ROOT,file),join(root,file));
 }
});

test('non-flow model callers keep observer sources mandatory and pin changes invalidate their manifest',async()=>{
 const args={policy:{mode:'demo'},analyst:{version:1,style:'active'},entryPolicyVersion:'trend-pullback-model-v1'};
 const base=await captureStrategyVersion(args),root=await copySources(base);
 assert.equal(base.executionScope,undefined);assert.equal(base.observerProvenance,undefined);
 assert.ok(observerFiles.every(path=>base.sources.some(source=>source.path===path)));
 await appendFile(join(root,'config/model-execution.json'),'\n');
 assert.notEqual((await captureStrategyVersion({...args,root})).fingerprint,base.fingerprint);
 await unlink(join(root,'config/model-execution.json'));
 await assert.rejects(captureStrategyVersion({...args,root}),{code:'ENOENT'});
});

test('historical full-scope and new flow manifests retain exact attribution without rewriting stored evidence',async()=>{
 const f=await fixture(),local=await temp(),id=createHash('sha256').update(f.snapshot.id).digest('hex').slice(0,32),tag='codex-'+id;
 const record={id,tag,status:'pending',action:'buy',pair:f.proposal.pair,snapshotId:f.snapshot.id,at:new Date(f.now+1000).toISOString()};
 const trade={trade_id:1,pair:record.pair,enter_tag:tag},file=join(local,'runs',f.snapshot.id+'.version.json');
 const oldContract=canonical({schemaVersion:1,mode:'demo',analyst:{version:1,style:'active'},policy:{mode:'demo'},engine:null,
  sources:[{path:'src/model-entry.mjs',sha256:'a'.repeat(64)}]});
 const historical={...oldContract,fingerprint:createHash('sha256').update(JSON.stringify(oldContract)).digest('hex'),
  capturedAt:new Date(f.now).toISOString(),scope:'Historical full source scope'};
 const current=await captureStrategyVersion({policy:{mode:'demo'},analyst:{version:1,style:'active'},now:f.now});
 for(const version of [historical,current]){
  await writeJson(file,version);const before=await readFile(file,'utf8');
  const result=await readTradeVersions(local,[trade],[record],'demo');
  assert.equal(result.versions[1],version.fingerprint);assert.deepEqual(result.warnings,[]);
  assert.equal(await readFile(file,'utf8'),before);
 }
});
