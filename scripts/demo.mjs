import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../test/fixtures.mjs';
import { execute } from '../src/bridge.mjs';
const f=await fixture(),local=await mkdtemp(join(tmpdir(),'binance-trade-demo-'));
let calls=0;
const client={snapshot:async()=>f.account,submit:async(p,tag)=>{calls++;return {trade_id:1,pair:p.pair,enter_tag:tag};}};
const first=await execute({...f,now:()=>f.now,local,client,getQuote:async()=>f.executionQuote});
let replay;try{await execute({...f,now:()=>f.now,local,client});}catch(e){replay=e.message;}
console.log(JSON.stringify({mode:'offline-demo',realOrders:0,simulatedSubmissions:calls,first,replay,journalDirectory:local},null,2));
