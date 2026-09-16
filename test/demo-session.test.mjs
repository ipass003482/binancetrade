import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {ROOT} from '../src/paths.mjs';
import {readDemoSession,validateDemoSession,sessionTrades,sessionJournal} from '../src/demo-session.mjs';
const now=Date.parse('2026-09-16T12:00:00.000Z');
const session={schemaVersion:1,id:'11111111-1111-4111-8111-111111111111',startedAt:'2026-09-16T04:00:00.000Z',modes:['demo','demo-futures']};

test('session loader is read-only, missing is legacy and malformed metadata is never legacy',async t=>{
 const base=resolve(ROOT,'local');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'test-session-')),file=join(dir,'demo-session.json');
 t.after(async()=>{const rel=relative(base,resolve(dir));assert.ok(rel.startsWith('test-session-')&&!rel.includes('..'));await rm(dir,{recursive:true,force:true});});
 assert.equal(await readDemoSession({file,now}),null);
 await writeFile(file,JSON.stringify(session));assert.deepEqual(await readDemoSession({file,now}),session);
 await writeFile(file,'{');await assert.rejects(readDemoSession({file,now}),/^Error: DEMO_SESSION_INVALID$/);
 for(const value of [{...session,password:'private'},{...session,startedAt:'2026-09-17T00:00:00.000Z'},
  {...session,startedAt:'2026-09-16T12:00:00+08:00'},{...session,id:'bad'},
  {...session,modes:['demo']},{...session,schemaVersion:2},null])assert.throws(()=>validateDemoSession(value,{now}),/DEMO_SESSION_INVALID/);
});

test('native ID reuse is scoped by original open time; late old settlements remain outside',()=>{
 const start=Date.parse(session.startedAt),old={trade_id:1,open_timestamp:start-1,is_open:false},fresh={trade_id:1,open_timestamp:start,is_open:false};
 assert.deepEqual(sessionTrades([old,fresh],session),[fresh]);
 assert.throws(()=>sessionTrades([{trade_id:9,profit_abs:-100}],session),/SESSION_TRADE_TIME_INVALID/);
 for(const is_open of [undefined,'true',1])assert.throws(()=>sessionTrades([{...old,is_open}],session),/SESSION_TRADE_STATUS_INVALID/);
 const journal=[{id:'old',status:'pending',at:new Date(start-1).toISOString()},
  {id:'old',status:'submitted',at:new Date(start+1).toISOString()},
  {id:'fresh',status:'pending',at:session.startedAt}];
 assert.deepEqual(sessionJournal(journal,session),[journal[2]]);
 assert.equal(sessionJournal(journal,null),journal);
});
