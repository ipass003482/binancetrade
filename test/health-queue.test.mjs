import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {healthUpdate,event} from '../src/health.mjs';
test('concurrent background health and cycle updates preserve every field',async()=>{
 const local=await mkdtemp(join(tmpdir(),'health-queue-'));
 const results=await Promise.allSettled(Array.from({length:20},(_,i)=>healthUpdate(local,{['field'+i]:i})));
 assert.equal(results.filter(r=>r.status==='rejected').length,0);
 const actual=JSON.parse(await readFile(join(local,'health.json'),'utf8'));
 for(let i=0;i<20;i++)assert.equal(actual['field'+i],i);
});
test('concurrent events remain complete and ordered',async()=>{
 const local=await mkdtemp(join(tmpdir(),'health-events-'));
 await Promise.all(Array.from({length:20},(_,i)=>event(local,{type:'test',index:i})));
 const rows=(await readFile(join(local,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(r=>r.index),Array.from({length:20},(_,i)=>i));
});
test('external lock remains fail closed and failed update does not poison queue',async()=>{
 const local=await mkdtemp(join(tmpdir(),'health-external-'));const file=join(local,'health.lock');
 await writeFile(file,'external owner');
 await assert.rejects(healthUpdate(local,{bad:true}),/BUSY_OR_STALE_LOCK/);
 assert.equal(await readFile(file,'utf8'),'external owner');
 await unlink(file);await healthUpdate(local,{good:true});
 const actual=JSON.parse(await readFile(join(local,'health.json'),'utf8'));assert.equal(actual.good,true);assert.equal(actual.bad,undefined);
});
