import test from 'node:test';
import assert from 'node:assert/strict';
import {buildKevPortfolioEligibility,readKevPortfolioEligibility,kevPortfolioCandidateRejection} from '../src/kev-portfolio.mjs';

const boundary=Date.parse('2026-09-29T01:23:00Z'),now=boundary+6000;
const snapshot={id:'portfolio-advisory-test',mode:'demo',decisionBoundary:boundary};
function accounts(){return Object.fromEntries(['demo','demo-futures'].map(mode=>[mode,{
 observedAt:new Date(now).toISOString(),engine:{demo_trading:true,dry_run:false,exchange:'binance',
 trading_mode:mode==='demo'?'spot':'futures',margin_mode:mode==='demo'?'':'isolated',state:'running'},trades:[]}]))}
const position=(pair,isShort=false)=>({trade_id:129,pair,is_short:isShort,is_open:true,has_open_orders:false});
const reject=(receipt,pair='ETH/USDT',action='buy',s=snapshot,at=now)=>
 kevPortfolioCandidateRejection({receipt,snapshot:s,pair,action,now:at});

test('cross-mode opposite position excludes only the conflicting base and leaves same-direction exposure to the final guard',()=>{
 const a=accounts();a['demo-futures'].trades=[position('ETH/USDT:USDT',true)];
 const receipt=buildKevPortfolioEligibility({snapshot,accounts:a,now});
 assert.equal(receipt.status,'ok');assert.equal(reject(receipt),'PORTFOLIO_OPPOSITE_POSITION');
 assert.equal(reject(receipt,'BTC/USDT'),null);
 a['demo-futures'].trades[0].is_short=false;
 assert.equal(reject(buildKevPortfolioEligibility({snapshot,accounts:a,now})),null);
 a.demo.trades=[position('ETH/USDT')];
 assert.equal(reject(buildKevPortfolioEligibility({snapshot,accounts:a,now})),'PORTFOLIO_DUPLICATE_POSITION');
});

test('futures short cannot oppose a current spot long while unrelated futures candidates remain available',()=>{
 const a=accounts(),s={...snapshot,mode:'demo-futures'};a.demo.trades=[position('ETH/USDT')];
 const receipt=buildKevPortfolioEligibility({snapshot:s,accounts:a,now});
 assert.equal(reject(receipt,'ETH/USDT:USDT','open-short',s),'PORTFOLIO_OPPOSITE_POSITION');
 assert.equal(reject(receipt,'ETH/USDT:USDT','open-long',s),null);
 assert.equal(reject(receipt,'BTC/USDT:USDT','open-short',s),null);
});

test('missing stale future-dated or wrong-identity accounts never become an empty eligible portfolio',()=>{
 for(const [mutate,reason] of [
  [a=>delete a['demo-futures'],'KEV_PORTFOLIO_ACCOUNT_UNAVAILABLE'],
  [a=>a.demo.observedAt=new Date(now-15001).toISOString(),'KEV_PORTFOLIO_ACCOUNT_STALE'],
  [a=>a.demo.observedAt=new Date(now+1).toISOString(),'KEV_PORTFOLIO_ACCOUNT_STALE'],
  [a=>a['demo-futures'].engine.demo_trading=false,'KEV_PORTFOLIO_ACCOUNT_IDENTITY'],
  [a=>a['demo-futures'].engine.margin_mode='cross','KEV_PORTFOLIO_ACCOUNT_IDENTITY'],
  [a=>a.demo.trades=[{...position('ETH/USDT'),is_short:true}],'KEV_PORTFOLIO_POSITION_INVALID'],
  [a=>a.demo.trades=[{...position('ETH/USDT'),has_open_orders:true}],'KEV_PORTFOLIO_PENDING_ORDER']
 ]){
  const a=accounts();mutate(a);const receipt=buildKevPortfolioEligibility({snapshot,accounts:a,now});
  assert.equal(receipt.status,'unavailable');assert.equal(reject(receipt),reason);
  assert.equal(reject(receipt,'BTC/USDT'),reason);
 }
 assert.equal(reject(null),'KEV_PORTFOLIO_CONTEXT_MISSING');
});

test('receipt preserves the original observation through Kev latency and cannot bind another snapshot or be changed',()=>{
 const a=accounts();a['demo-futures'].trades=[position('ETH/USDT:USDT',true)];
 const receipt=buildKevPortfolioEligibility({snapshot,accounts:a,now});
 assert.ok(Object.isFrozen(receipt));assert.ok(Object.isFrozen(receipt.positions));
 assert.equal(reject(receipt,'ETH/USDT','buy',snapshot,now+20000),'PORTFOLIO_OPPOSITE_POSITION');
 assert.equal(receipt.assessedAt,new Date(now).toISOString());
 assert.equal(receipt.accountObservedAt.demo,new Date(now).toISOString());
 assert.equal(receipt.finalPortfolioCheckRequired,true);
 assert.equal(reject(receipt,'ETH/USDT','buy',{...snapshot,id:'different'}),'KEV_PORTFOLIO_CONTEXT_INVALID');
 assert.equal(reject({...receipt,positions:[]}),'KEV_PORTFOLIO_CONTEXT_INVALID');
 assert.equal(reject(receipt,'ETH/USDT','buy',snapshot,now-1),'KEV_PORTFOLIO_CONTEXT_INVALID');
});

test('account-only reader invokes each identity-checked snapshot once and timestamps each completion independently',async()=>{
 const a=accounts(),calls=[];let clock=now;
 const receipt=await readKevPortfolioEligibility({snapshot,now:()=>clock,getConfig:async()=>({maxSnapshotAgeSeconds:15}),
  getClients:async()=>Object.fromEntries(['demo','demo-futures'].map(mode=>[mode,{snapshot:async()=>{
   calls.push(mode);if(mode==='demo-futures'){await Promise.resolve();clock+=16000;}return a[mode];
  },history:()=>assert.fail('history must not be read')}]))});
 assert.deepEqual(calls,['demo','demo-futures']);assert.equal(receipt.status,'unavailable');
 assert.equal(receipt.reason,'KEV_PORTFOLIO_ACCOUNT_STALE');
});

test('failed account and config reads propagate unchanged for observation wait or permanent fault handling',async()=>{
 for(const error of [Error('HTTP_503'),Error('ENGINE_MODE_MISMATCH')]){
  await assert.rejects(readKevPortfolioEligibility({snapshot,now:()=>now,getConfig:async()=>({maxSnapshotAgeSeconds:15}),
   getClients:async()=>({demo:{snapshot:async()=>{throw error}},'demo-futures':{snapshot:async()=>accounts()['demo-futures']}})}),
   actual=>actual===error);
 }
 const error=Error('PORTFOLIO_CONFIG_INVALID');
 await assert.rejects(readKevPortfolioEligibility({snapshot,getClients:async()=>({}),getConfig:async()=>{throw error;}}),actual=>actual===error);
});
