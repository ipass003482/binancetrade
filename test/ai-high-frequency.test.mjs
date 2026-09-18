import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy } from '../src/config.mjs';
import { buildAnalystPrompt } from '../src/analyst.mjs';
import { collectHighFrequencySnapshot, runHighFrequencyCycle } from '../src/ai-high-frequency.mjs';

function mockMarket(url){
 const u=new URL(url),symbol=u.searchParams.get('symbol')??'BTCUSDT';
 if(u.pathname.endsWith('/bookTicker'))return new Response(JSON.stringify({symbol,bidPrice:'100',askPrice:'100.01'}));
 if(u.pathname.endsWith('/depth'))return new Response(JSON.stringify({lastUpdateId:7,
  bids:Array.from({length:20},(_,i)=>[String(100-i*.01),'2']),asks:Array.from({length:20},(_,i)=>[String(100.01+i*.01),'1'])}));
 if(u.pathname.endsWith('/aggTrades'))return new Response(JSON.stringify([
  {p:'100',q:'1',T:1000,m:false},{p:'100.02',q:'1',T:2000,m:false},{p:'100.01',q:'0.5',T:3000,m:true}]));
 if(u.pathname.endsWith('/klines'))return new Response(JSON.stringify(Array.from({length:30},(_,i)=>[
  i*60000,'100','101','99',String(100+i*.01),'10',i*60000+59999])));
 throw new Error('UNEXPECTED_URL');
}

test('high-frequency snapshot derives depth, taker-flow and short-horizon momentum evidence',async()=>{
 const snapshot=await collectHighFrequencySnapshot({fetchImpl:mockMarket,now:1700000000000,costs:{slippageBpsPerSide:5,priceSpaceBufferBps:30}});
 assert.equal(snapshot.mode,'dry-run');
 assert.equal(snapshot.purpose,'ai-high-frequency-v1');
 assert.equal(snapshot.markets.length,4);
 assert.equal(snapshot.errors.length,0);
 assert.ok(snapshot.markets[0].orderBook.imbalanceTop5>0);
 assert.ok(snapshot.markets[0].takerFlow.buyShare>0.5);
 assert.ok(snapshot.markets[0].microMomentum.return5mBps>0);
 assert.equal(snapshot.markets[0].cost.feeStatus,'unavailable');
 assert.equal(snapshot.evidence.filter(e=>e.id.startsWith('cost:')).length,4);
});

test('high-frequency prompt selects the CLI observer contract without changing Demo rules',async()=>{
 const policy=await loadPolicy('dry-run'),snapshot={id:'00000000-0000-4000-8000-000000000001',mode:'dry-run',createdAt:new Date().toISOString(),markets:[],evidence:[]};
 const result=await buildAnalystPrompt({snapshot,policy,purpose:'high-frequency-cli'});
 assert.equal(result.metadata.purpose,'high-frequency-cli');
 assert.match(result.prompt,/ai-high-frequency-v1/);
 assert.match(result.prompt,/15～60 秒/);
});

test('high-frequency cycle stays research-only and converts a sell with no position to HOLD',async()=>{
 const local=await mkdtemp(join(tmpdir(),'binance-ai-high-frequency-')),policy=await loadPolicy('dry-run');
 const snapshot=await collectHighFrequencySnapshot({fetchImpl:mockMarket,now:1700000000000,costs:{slippageBpsPerSide:5,priceSpaceBufferBps:30}});
 const raw={action:'sell',pair:'BTC/USDT',stakeUsdt:'0',snapshotId:snapshot.id,evidenceIds:[],reason:'synthetic observer result'};
 const result=await runHighFrequencyCycle({local,policy,collectFn:async()=>snapshot,analyzeFn:async()=>({proposal:raw,metadata:{purpose:'high-frequency-cli',requestedModel:'test'},runDir:'test-run'})});
 assert.equal(result.tradeEnabled,false);
 assert.equal(result.proposal.action,'hold');
 assert.match(result.proposal.reason,/OBSERVATION_ONLY_NO_OPEN_POSITION/);
 assert.deepEqual(JSON.parse(await readFile(join(local,'latest.json'),'utf8')),result);
});

test('high-frequency cycle refuses Demo execution modes',async()=>{
 await assert.rejects(runHighFrequencyCycle({policy:{mode:'demo'}}),/HIGH_FREQUENCY_RESEARCH_DRY_RUN_ONLY/);
});
