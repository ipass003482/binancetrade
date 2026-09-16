import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {supervisorDecision,recoverAbsentWorkerLock} from '../src/supervisor.mjs';import {writeJson,exists} from '../src/io.mjs';
const running={continuous:true,inventoryUnknown:false,engineAvailable:true,engineOwnerAlive:true,engineProcesses:true,portOpen:true,unavailableCount:0,stopped:false,unresolved:false,watchOwnerAlive:true,watchProcesses:true,heartbeatFresh:true,cycleFresh:true};
test('supervisor restarts only proven absent workers and never overrides STOP or unknown submissions',()=>{
 assert.equal(supervisorDecision(running).reason,'RUNNING');
 assert.equal(supervisorDecision({...running,stopped:true,watchOwnerAlive:false}).action,'observe');
 assert.equal(supervisorDecision({...running,unresolved:true,watchOwnerAlive:false}).reason,'UNRESOLVED_SUBMISSION');
 assert.equal(supervisorDecision({...running,watchOwnerAlive:false,watchProcesses:false}).action,'start_watch');
 assert.equal(supervisorDecision({...running,watchOwnerAlive:false}).action,'alert');
 const absent={...running,engineAvailable:false,engineOwnerAlive:false,engineProcesses:false,portOpen:false,unavailableCount:3};
 assert.equal(supervisorDecision(absent).action,'start_engine');
 for(const change of [{engineOwnerAlive:true},{engineProcesses:true},{portOpen:true},{inventoryUnknown:true}])assert.equal(supervisorDecision({...absent,...change}).action,'alert');
 assert.equal(supervisorDecision({...absent,unavailableCount:2}).action,'observe');
 assert.equal(supervisorDecision({...running,heartbeatFresh:false}).reason,'WATCH_HEARTBEAT_STALE');
 assert.equal(supervisorDecision({...running,cycleFresh:false}).reason,'CYCLE_STALE');
});
test('recovery cannot remove live, uncertain, child-owned or process-conflicted locks',async()=>{
 const local=await mkdtemp(join(tmpdir(),'supervisor-')),path=join(local,'engine.lock');
 await writeJson(path,{pid:10,childPid:11});
 for(const state of [()=> 'alive',()=> 'unknown',p=>p===11?'alive':'dead'])await assert.rejects(recoverAbsentWorkerLock(local,'engine',{state}),/NOT_PROVEN_ABSENT/);
 await assert.rejects(recoverAbsentWorkerLock(local,'engine',{state:()=> 'dead',processes:[{pid:12}]}),/NOT_PROVEN_ABSENT/);
 assert.equal(await exists(path),true);
 await recoverAbsentWorkerLock(local,'engine',{state:()=> 'dead',processes:[]});assert.equal(await exists(path),false);
});
