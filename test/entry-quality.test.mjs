import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEntryQuality } from '../src/entry-quality.mjs';

const CANDLE=900000,BOUNDARY=Date.parse('2026-09-10T12:00:00Z'),NOW=BOUNDARY+5000;
function fixture({action='buy',falling=false}={}){
 const futures=action.startsWith('open-'),pair=futures?'BTC/USDT:USDT':'BTC/USDT';
 const candles=Array.from({length:32},(_,i)=>{
  const close=falling?200-i:100+i,openTime=BOUNDARY-(32-i)*CANDLE;
  return {openTime,closeTime:openTime+CANDLE-1,open:String(close),high:String(close+1),low:String(close-1),close:String(close),volume:'100'};
 });
 const market={pair,[futures?'verifiedFutures':'verifiedSpot']:true,candles};
 const marketId=(futures?'futures:':'spot:')+pair;
 return {now:NOW,analyst:{style:'active'},proposal:{action,pair,evidenceIds:[marketId]},snapshot:{
  mode:futures?'demo-futures':'demo',createdAt:new Date(NOW).toISOString(),markets:[market],evidence:[
   {id:marketId,status:'ok',data:structuredClone(market)},
   {id:'technical:'+pair,pair,status:'ok',data:{return1hPct:'999',return4hPct:'999',sma8:'0',sma20:'0',volumeVsPrior19:'999'}}
  ]}};
}
function prices(f,closes){
 f.snapshot.markets[0].candles.forEach((c,i)=>Object.assign(c,{open:String(closes[i]),high:String(closes[i]+1),low:String(closes[i]-1),close:String(closes[i])}));
}

test('active spot and futures long entries require positive aligned direction',()=>{
 for(const action of ['buy','open-long']){
  const pass=evaluateEntryQuality(fixture({action}));
  assert.equal(pass.eligible,true);assert.deepEqual(pass.reasons,[]);
  assert.equal(pass.metrics.lastClose,'131');assert.equal(pass.metrics.sma8,'127.5');
  assert.equal(pass.metrics.sma20,'121.5');assert.equal(pass.metrics.volumeVsPrior19,'1');
  const fail=evaluateEntryQuality(fixture({action,falling:true}));
  assert.equal(fail.eligible,false);assert.ok(fail.reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
 }
});

test('futures short entries require negative direction and price below both averages',()=>{
 const pass=evaluateEntryQuality(fixture({action:'open-short',falling:true}));
 assert.equal(pass.eligible,true);assert.equal(pass.metrics.direction,'short');
 const fail=evaluateEntryQuality(fixture({action:'open-short'}));
 assert.equal(fail.eligible,false);assert.ok(fail.reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
 assert.ok(fail.reasons.includes('ENTRY_PRICE_NOT_BEYOND_BOTH_SMA'));
});

test('flat or conflicting h1/h4 directions reject entry',()=>{
 for(const reference of [15,27]){
  const f=fixture(),closes=f.snapshot.markets[0].candles.map(c=>Number(c.close));
  closes[reference]=132;prices(f,closes);
  assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
 }
 const f=fixture();prices(f,Array(32).fill(100));
 assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
});

test('returns alone do not pass if price is on the wrong side of either average',()=>{
 for(const highIndex of [12,29]){
  const f=fixture(),closes=Array(32).fill(100);closes[31]=101;closes[highIndex]=1000;prices(f,closes);
  const r=evaluateEntryQuality(f);
  assert.equal(r.eligible,false);assert.ok(!r.reasons.includes('ENTRY_DIRECTION_NOT_ALIGNED'));
  assert.ok(r.reasons.includes('ENTRY_PRICE_NOT_BEYOND_BOTH_SMA'));
 }
});

test('relative volume below one rejects even if a rounded indicator says one',()=>{
 const f=fixture();f.snapshot.markets[0].candles.at(-1).volume='99.99999';
 f.snapshot.evidence[1].data.volumeVsPrior19='1.0000';
 const r=evaluateEntryQuality(f);
 assert.equal(r.eligible,false);assert.equal(r.metrics.volumeVsPrior19,'0.9999999');
 assert.ok(r.reasons.includes('ENTRY_RELATIVE_VOLUME_BELOW_ONE'));
});

test('zero baseline volume is undefined rather than passing as infinite volume',()=>{
 const f=fixture();f.snapshot.markets[0].candles.slice(0,-1).forEach(c=>{c.volume='0';});
 const r=evaluateEntryQuality(f);assert.equal(r.eligible,false);
 assert.equal(r.metrics.volumeVsPrior19,null);assert.ok(r.reasons.includes('ENTRY_RELATIVE_VOLUME_UNDEFINED'));
});

test('indicator payloads cannot override the snapshot candle calculations',()=>{
 const f=fixture({falling:true});
 const r=evaluateEntryQuality(f);
 assert.equal(r.eligible,false);assert.ok(Number(r.metrics.return1hPct)<0);
 assert.notEqual(r.metrics.sma8,f.snapshot.evidence[1].data.sma8);
 const valid=fixture();valid.snapshot.evidence[1].data={volumeVsPrior19:'0',return1hPct:'-100'};
 assert.equal(evaluateEntryQuality(valid).eligible,true);
});

test('required evidence must be unique, usable, identify the pair, and cite the market',()=>{
 for(const index of [0,1]){
  for(const mutation of ['remove','unavailable','duplicate','wrongPair']){
   const f=fixture();
   if(mutation==='remove')f.snapshot.evidence.splice(index,1);
   if(mutation==='unavailable')f.snapshot.evidence[index].status='unavailable';
   if(mutation==='duplicate')f.snapshot.evidence.push(structuredClone(f.snapshot.evidence[index]));
   if(mutation==='wrongPair'){
    if(index===0)f.snapshot.evidence[index].data.pair='ETH/USDT';
    else f.snapshot.evidence[index].pair='ETH/USDT';
   }
   assert.equal(evaluateEntryQuality(f).eligible,false,`${index}: ${mutation}`);
  }
 }
 const f=fixture();f.proposal.evidenceIds=[];
 assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_MARKET_CITATION_REQUIRED'));
});

test('missing or duplicate market and unverified identity reject entry',()=>{
 for(const mutation of ['missing','duplicate','unverified']){
  const f=fixture();
  if(mutation==='missing')f.snapshot.markets=[];
  if(mutation==='duplicate')f.snapshot.markets.push(structuredClone(f.snapshot.markets[0]));
  if(mutation==='unverified')f.snapshot.markets[0].verifiedSpot=false;
  assert.equal(evaluateEntryQuality(f).eligible,false,mutation);
 }
});

test('latest candle must be the completed interval at collection start',()=>{
 for(const shift of [-CANDLE,CANDLE]){
  const f=fixture();f.snapshot.markets[0].candles.forEach(c=>{c.openTime+=shift;c.closeTime+=shift;});
  const r=evaluateEntryQuality(f);assert.equal(r.eligible,false);
  assert.ok(r.reasons.includes('ENTRY_CANDLE_NOT_LATEST_COMPLETED'));
  if(shift>0)assert.ok(r.reasons.includes('ENTRY_CANDLE_NOT_CLOSED'));
 }
 const f=fixture();f.now=BOUNDARY+CANDLE+5000;f.snapshot.completedAt=new Date(f.now).toISOString();
 assert.equal(evaluateEntryQuality(f).eligible,true,'slow optional evidence does not change the collection candle');
 const boundary=fixture();boundary.snapshot.createdAt=new Date(BOUNDARY).toISOString();
 assert.equal(evaluateEntryQuality(boundary).eligible,true,'candle ending one millisecond before boundary is complete');
});

test('malformed times, future snapshots and reversed collection timestamps reject',()=>{
 for(const field of ['createdAt','completedAt']){
  for(const time of ['invalid',new Date(NOW+1).toISOString()]){
   const f=fixture();f.snapshot[field]=time;
   assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_SNAPSHOT_TIME_INVALID'));
  }
 }
 const f=fixture();f.snapshot.completedAt=new Date(NOW-1).toISOString();
 assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_SNAPSHOT_TIME_INVALID'));
});

test('missing, discontinuous, unaligned, incomplete or invalid OHLCV is rejected',()=>{
 const changes=[
  candles=>candles.splice(0,13),
  candles=>{candles[10].openTime+=CANDLE;candles[10].closeTime+=CANDLE;},
  candles=>candles.forEach(c=>{c.openTime+=1;c.closeTime+=1;}),
  candles=>{candles.at(-1).closeTime-=1;},
  candles=>{candles[10].close='NaN';},
  candles=>{candles[10].volume='-1';},
  candles=>{candles[10].volume=null;},
  candles=>{candles[10].high='1';},
  candles=>{candles[10].low='999';}
 ];
 for(const change of changes){const f=fixture();change(f.snapshot.markets[0].candles);assert.equal(evaluateEntryQuality(f).eligible,false);}
 const f=fixture();delete f.snapshot.markets[0].candles;
 assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_CANDLES_REQUIRED'));
});

test('tiny positive unrounded returns are not mistaken for zero',()=>{
 const f=fixture(),candles=f.snapshot.markets[0].candles;
 prices(f,Array(32).fill(100));Object.assign(candles.at(-1),{open:'100.00000001',close:'100.00000001'});
 const r=evaluateEntryQuality(f);assert.equal(r.eligible,true);assert.ok(Number(r.metrics.return1hPct)>0);
});

test('HOLD, exits and conservative style bypass new entry prerequisites',()=>{
 for(const action of ['hold','sell','close-long','close-short'])
  assert.deepEqual(evaluateEntryQuality({proposal:{action}}),{eligible:true,reasons:[],metrics:null});
 for(const action of ['buy','open-long','open-short'])
  assert.equal(evaluateEntryQuality({proposal:{action},analyst:{style:'conservative'}}).eligible,true);
});

test('invalid caller inputs throw and active action/mode mismatches reject',()=>{
 assert.throws(()=>evaluateEntryQuality(),/ENTRY_PROPOSAL_INVALID/);
 assert.throws(()=>evaluateEntryQuality({proposal:{action:'unknown'}}),/ENTRY_ACTION_INVALID/);
 assert.throws(()=>evaluateEntryQuality({proposal:{action:'buy'}}),/ENTRY_ANALYST_INVALID/);
 const f=fixture();f.now=NaN;assert.throws(()=>evaluateEntryQuality(f),/ENTRY_TIME_INVALID/);
 for(const mode of ['demo-futures','live']){
  const f=fixture();f.snapshot.mode=mode;assert.ok(evaluateEntryQuality(f).reasons.includes('ENTRY_ACTION_MODE_MISMATCH'));
 }
});
