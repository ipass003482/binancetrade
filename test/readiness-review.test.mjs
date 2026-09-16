import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReadinessReview,collectMarketComparison} from '../src/readiness-review.mjs';
import {PERFORMANCE_DEFAULTS} from '../src/performance.mjs';
const at='2026-09-11T01:00:00Z',start='2026-08-01T00:00:00Z';
function fixture(){
 const histories={demo:[],'demo-futures':[]},groups=new Map(),total=[];
 function add(mode,id,net,version='v7',purpose='strategy',extra={}){
  const pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',t={trade_id:id,pair,enter_tag:'codex-'+mode+id,
   is_open:false,is_short:mode==='demo-futures',profit_abs:net,stake_amount:100,leverage:1,
   open_timestamp:Date.parse('2026-08-31T15:00:00Z'),close_timestamp:Date.parse('2026-08-31T16:00:00Z'),
   fee_open_cost:.1,fee_close_cost:.1,...extra};
  histories[mode].push(t);
  const ref={mode,tradeId:id,pair,tag:t.enter_tag,isOpen:t.is_open,netRealizedUsdt:t.is_open?null:net};
  const key=purpose+version;if(!groups.has(key))groups.set(key,{purpose,version,trades:[]});
  groups.get(key).trades.push(ref);total.push(ref);return t;
 }
 add('demo',1,10,'v6');add('demo',2,-2);add('demo-futures',1,1);add('demo',3,-.1,'probe','execution_probe');
 add('demo',4,-100,'v7','strategy',{is_open:true,close_timestamp:null});
 return {histories,currentVersion:'v7',thresholds:PERFORMANCE_DEFAULTS,observedAt:at,
  portfolio:{source:'freqtrade-demo-portfolio',evidenceComplete:true,startedAt:start,asOf:at,capitalUsdt:'2000',netPnlUsdt:'-91.1',
   sampledMaxDrawdownUsdt:'100',byVersion:[...groups.values()],total:{trades:total}}};
}
test('monthly evidence keeps versions, modes, probes and open losses separate with Taipei month boundaries',()=>{
 const r=buildReadinessReview(fixture()),month=r.monthlyRealized[0];
 assert.equal(month.month,'2026-09');assert.equal(month.calendarMonthClosed,false);
 assert.equal(month.groups.length,4);assert.equal(r.modeReviews.demo.currentVersion.summary.closedTrades,1);
 assert.equal(r.modeReviews.demo.currentVersion.summary.netRealizedUsdt,'-2');assert.equal(r.openTrades.length,1);
 assert.equal(r.netPnlUsdt,'-91.1');assert.equal(r.monthlyEquityReturns,null);assert.equal(r.monthlyProfitabilityValidated,false);
 assert.equal(r.promotionAuthorized,false);assert.equal(r.modeReviews.demo.currentVersion.assessment.status,'insufficient_evidence');
 assert.equal(month.groups.find(g=>g.mode==='demo'&&g.version==='v7').netPlusRecordedFeesUsdt,'-1.8');
});
test('a trade closing just before Taipei midnight belongs to the previous month and the first month is partial',()=>{
 const f=fixture();f.histories.demo[0].close_timestamp=Date.parse('2026-08-31T15:59:59.999Z');
 const m=buildReadinessReview(f).monthlyRealized[0];
 assert.equal(m.month,'2026-08');assert.equal(m.calendarMonthClosed,true);assert.equal(m.experimentCoversMonthStart,false);
});

test('volume variants have independent readiness samples and are never pooled with base version',()=>{
 const f=fixture();
 f.portfolio.byVersion.find(g=>g.version==='v6').version='v7/volume-forward-v1/vol-08';
 f.portfolio.byVersion.find(g=>g.version==='v7').version='v7/volume-forward-v1/vol-10';
 const r=buildReadinessReview(f),v=r.modeReviews.demo;
 assert.equal(v.currentVersion.summary.closedTrades,0);
 assert.equal(v.parameterVariants['v7/volume-forward-v1/vol-08'].summary.netRealizedUsdt,'10');
 assert.equal(v.parameterVariants['v7/volume-forward-v1/vol-10'].summary.netRealizedUsdt,'-2');
 assert.equal(v.parameterVariants['v7/volume-forward-v1/vol-10'].summary.closedTrades,1);
});
test('readiness rejects missing, changed, duplicated or unverified actual trade evidence',()=>{
 for(const mutate of [f=>f.portfolio.evidenceComplete=false,f=>f.histories.demo.pop(),f=>f.histories.demo[0].profit_abs=99,
  f=>f.histories.demo[0].pair='ETH/USDT',f=>f.histories.demo.push(f.histories.demo[0]),
  f=>f.portfolio.byVersion[0].trades.push(f.portfolio.byVersion[0].trades[0]),f=>f.portfolio.asOf=start]){
  const f=fixture();mutate(f);assert.throws(()=>buildReadinessReview(f),/READINESS_/);
 }
});
test('missing recorded fees never become zero or change actual net results',()=>{
 const f=fixture();f.histories.demo[0].fee_open_cost=null;
 const g=buildReadinessReview(f).monthlyRealized[0].groups.find(g=>g.version==='v6');
 assert.equal(g.closedTradeRecordedFeesUsdt,null);assert.equal(g.netPlusRecordedFeesUsdt,null);assert.equal(g.netRealizedUsdt,'10');
});
test('formal-market comparison can only issue unsigned GET market data requests to pinned URLs',async()=>{
 const requests=[];
 const fetchImpl=async(url,opts)=>{
  requests.push({url,opts});assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');assert.equal(opts.body,undefined);
  assert.deepEqual(opts.headers,{Accept:'application/json'});
  const u=new URL(url),demo=u.host.startsWith('demo-'),bid=demo?'100':'101';
  return new Response(JSON.stringify({symbol:u.searchParams.get('symbol'),bidPrice:bid,askPrice:bid}),{status:200});
 };
 const r=await collectMarketComparison({pairsByMode:{demo:['BTC/USDT'],'demo-futures':['BTC/USDT:USDT']},fetchImpl,now:()=>Date.parse(at)});
 assert.equal(requests.length,4);assert.equal(r.rows.length,2);assert.equal(r.readOnly,true);
 assert.ok(r.rows.every(q=>q.status==='observed'&&Number(q.midDifferenceBps)<0));
 assert.deepEqual(requests.map(q=>new URL(q.url).host),['demo-api.binance.com','data-api.binance.vision','demo-fapi.binance.com','fapi.binance.com']);
 await assert.rejects(collectMarketComparison({pairsByMode:{demo:['BTC/USDT?redirect=bad'],'demo-futures':[]},fetchImpl}),/PAIRS_INVALID/);
});
test('quote comparison reports missing or mismatched data without inventing a zero difference',async()=>{
 for(const fetchImpl of [async()=>new Response('{}',{status:503}),async()=>new Response(JSON.stringify({symbol:'WRONG',bidPrice:'1',askPrice:'1'}))]){
  const r=await collectMarketComparison({pairsByMode:{demo:['BTC/USDT'],'demo-futures':[]},fetchImpl});
  assert.equal(r.rows[0].status,'unavailable');assert.equal(r.rows[0].midDifferenceBps,undefined);
 }
});
