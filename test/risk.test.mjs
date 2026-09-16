import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../src/risk.mjs';
import { validatePolicy } from '../src/config.mjs';
import { fixture,trade } from './fixtures.mjs';
test('accepts bounded simulated buy, checks decimals at boundary',async()=>{
 const f=await fixture();assert.equal(assess(f).action,'buy');
 f.proposal.stakeUsdt='50.00000001';assert.throws(()=>assess(f),/STAKE_LIMIT/);
});
for(const [name,mutate,pattern] of [
 ['live config',f=>{f.policy.mode='live';},/Invalid/],
 ['stale snapshot',f=>{f.now+=601000;},/STALE/],
 ['future snapshot',f=>{f.snapshot.createdAt=new Date(f.now+1000).toISOString();},/STALE/],
 ['wrong snapshot',f=>{f.proposal.snapshotId='f7604022-1448-4835-ae8c-35ef27dc504d';},/MISMATCH/],
 ['invented evidence',f=>{f.proposal.evidenceIds=['fake'];},/EVIDENCE/],
 ['unlisted symbol',f=>{f.proposal.pair='MEME/USDT';},/PAIR_NOT_ALLOWED/],
 ['wide spread',f=>{f.snapshot.markets[0].spreadBps=50;},/QUOTE/],
 ['stop switch',f=>{f.stopped=true;},/ENTRY_STOPPED/],
 ['existing position',f=>{f.account.trades=[trade('BTC/USDT')];},/ALREADY_EXISTS/],
 ['exposure limit',f=>{f.policy.maxExposureUsdt='30';f.account.trades=[trade()];},/EXPOSURE/],
 ['loss cap',f=>{f.account.daily.data[0].abs_profit=-20;},/DAILY_LOSS/],
 ['unrealized loss',f=>{f.account.trades=[{...trade(),total_profit_abs:-20}];},/DAILY_LOSS/],
 ['missing pnl',f=>{f.account.trades=[trade()];delete f.account.trades[0].total_profit_abs;},/Invalid/],
 ['missing daily data',f=>{f.account.daily.data=[];},/DAILY_STATE/],
 ['insufficient funds',f=>{f.account.balance.currencies[0].free=25;},/INSUFFICIENT/],
 ['rate cap includes pending entries',f=>{f.records=Array.from({length:4},()=>({status:'pending',action:'buy',at:new Date(f.now).toISOString()}));},/ENTRY_RATE/],
 ['no leverage field',f=>{f.proposal.leverage=10;},/Unrecognized/]
]){
 test(name,async()=>{const f=await fixture();mutate(f);if(name==='live config')assert.throws(()=>validatePolicy(f.policy),pattern);else assert.throws(()=>assess(f),pattern);});
}
test('stop and daily loss do not prevent closing an existing spot position',async()=>{
 const f=await fixture();f.stopped=true;f.proposal.action='sell';f.proposal.stakeUsdt='0';
 f.account.trades=[trade('BTC/USDT')];f.account.daily.data[0].abs_profit=-999;
 assert.equal(assess(f).tradeId,1);
 f.account.trades[0].has_open_orders=true;assert.throws(()=>assess(f),/NO_UNAMBIGUOUS/);
});

test('zero daily entry limit means unlimited entries',async()=>{
 const f=await fixture();f.policy.maxEntriesPerDay=0;
 f.records=Array.from({length:1000},()=>({status:'pending',action:'buy',at:new Date(f.now).toISOString()}));
 assert.equal(assess(f).action,'buy');
});

test('rejects execution quote that has moved since research',async()=>{
 const f=await fixture();f.executionQuote.ask='102';assert.throws(()=>assess(f),/PRICE_MOVED/);
});
test('rejects stale execution quote',async()=>{
 const f=await fixture();f.executionQuote.fetchedAt=new Date(f.now-16000).toISOString();assert.throws(()=>assess(f),/STALE_EXECUTION/);
});
