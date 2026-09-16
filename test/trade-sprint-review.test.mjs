import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildSprintReview,sprintMarkdown} from '../scripts/trade-sprint-review.mjs';

const startedAt='2026-09-14T02:58:25.478Z',base=Date.parse(startedAt),observedAt='2026-09-14T12:00:00Z';
const fingerprint='a'.repeat(64),prediction='b'.repeat(64),version='kronos-direction-v12';
const snapshot=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const intentId=n=>createHash('sha256').update(snapshot(n)).digest('hex').slice(0,32);

test('new flow sprint accepts both routes but does not change the expired net-edge goal',()=>{
 const t=trade(1,{net:'-.5'}),pending={entryPolicyVersion:'trend-pullback-flow-v1',entryRoute:'order-flow'};
 const journals={demo:journal(t,{pending}),'demo-futures':[]};
 const old=review([t],[],{journals});assert.equal(old.totalEntries,0);
 const g={...goal(),entryPolicyVersion:'trend-pullback-flow-v1',target:{scope:'each',count:100}};
 const fresh=review([t],[],{goal:g,journals});assert.equal(fresh.modes.demo.entries,1);assert.equal(fresh.modes.demo.netRealizedUsdt,'-0.5');
 assert.equal(fresh.modes.demo.entryRouteCohorts[0].entryRoute,'order-flow');assert.equal(fresh.completed,false);
});
const goal=()=>({schemaVersion:2,id:'2026-09-14-v12-30-each',source:'freqtrade-demo',startedAt,
 ruleVersion:version,modelFingerprint:fingerprint,target:{scope:'each',count:1},deadline:new Date(base+180000).toISOString(),timezone:'Asia/Taipei',entryPolicyVersion:'forecast-net-edge-v1',
 modes:{demo:{excludedTradeIds:[],baselineTradeCount:0},'demo-futures':{excludedTradeIds:[],baselineTradeCount:0}}});
function trade(n,{mode='demo',open=false,short=false,net='1.25',...extra}={}){
 const id=intentId(n),pair=mode==='demo'?'BTC/USDT':'BTC/USDT:USDT',tag='codex-'+id;
 return {trade_id:n,pair,enter_tag:tag,is_open:open,is_short:short,open_timestamp:base+n*60000,
  close_timestamp:open?null:base+n*60000+30000,profit_abs:net,stake_amount:50,leverage:1,
  trading_mode:mode==='demo'?'spot':'futures',orders:[{order_id:'entry-'+n,pair,ft_order_tag:tag,
   ft_order_side:short?'sell':'buy',ft_is_entry:true,status:'closed',is_open:false,filled:1,cost:50,
   amount:1,remaining:0,order_filled_timestamp:base+n*60000-774}],...extra};
}
function journal(t,{mode='demo',pending={},terminal={}}={}){
 const id=t.enter_tag.slice(6),snapshotId=snapshot(t.trade_id),action=mode==='demo'?'buy':t.is_short?'open-short':'open-long';
 return [{id,at:new Date(t.open_timestamp-1000).toISOString(),status:'pending',action,pair:t.pair,tag:t.enter_tag,
  tradeId:null,purpose:'strategy',ruleVersion:version,snapshotId,entryPolicyVersion:'forecast-net-edge-v1',strategyFingerprint:'c'.repeat(64),
  model:{modelFingerprint:fingerprint,predictionSha256:prediction,snapshotId,issuedAt:new Date(t.open_timestamp-1500).toISOString(),usedForEntryDecision:true},...pending},
 {id,at:new Date(t.open_timestamp+1000).toISOString(),status:'submitted',action,tradeId:t.trade_id,pair:t.pair,tag:t.enter_tag,...terminal}];
}
function review(spot=[],futures=[],options={}){
 const histories=Object.fromEntries([['demo',spot],['demo-futures',futures]].map(([mode,trades])=>[mode,
  {source:'freqtrade-demo',historyComplete:true,observedAt,trades}]));
 const journals={demo:spot.flatMap(t=>journal(t)), 'demo-futures':futures.flatMap(t=>journal(t,{mode:'demo-futures'}))};
 return buildSprintReview({goal:goal(),histories,journals,observedAt,...options});
}


test('each target requires both modes while combined target counts both once',()=>{
 const t=trade(1,{net:'-.4'});const each=review([t]);assert.equal(each.completed,false);assert.equal(each.status,'deadline_missed');
 const g=goal();g.target.scope='combined';const combined=review([t],[],{goal:g});assert.equal(combined.completed,true);assert.equal(combined.totalEntries,1);assert.equal(combined.modes.demo.netRealizedUsdt,'-0.4');
});
test('fill at deadline and after deadline cannot satisfy quota, even if submitted before',()=>{
 for(const delta of [0,1]){
  const t=trade(1);t.orders[0].order_filled_timestamp=base+180000+delta;
  const r=review([t]);assert.equal(r.totalEntries,0);assert.equal(r.modes.demo.excluded.at(-1).reason,'ENTRY_FILL_AT_OR_AFTER_DEADLINE');
 }
 const before=trade(1);before.orders[0].order_filled_timestamp=base+180000-1;assert.equal(review([before]).totalEntries,1);
});
test('late split fill excludes entry as a whole, exits never add counts',()=>{
 const t=trade(1);t.orders.push({...t.orders[0],order_id:'late-part',order_filled_timestamp:base+180001});assert.equal(review([t]).totalEntries,0);
});
test('new target does not import old policy or excluded baseline fills',()=>{
 const old=trade(1),g=goal();g.modes.demo={excludedTradeIds:[1],baselineTradeCount:1};assert.equal(review([old],[],{goal:g}).totalEntries,0);
 const j={demo:journal(old,{pending:{entryPolicyVersion:'closed-price-momentum-v1'}}),'demo-futures':[]};
 const r=review([old],[],{journals:j});assert.equal(r.totalEntries,0);assert.equal(r.modes.demo.excluded.at(-1).reason,'OTHER_ENTRY_POLICY');
});
test('deadline freezes eligible entries but keeps later realized loss and original history',()=>{
 const t=trade(1,{net:'-1.5',close_timestamp:base+360000});const r=review([t]);assert.equal(r.totalEntries,1);assert.equal(r.modes.demo.netRealizedUsdt,'-1.5');assert.equal(r.modes.demo.allHistory.netRealizedUsdt,'-1.5');
});
test('missing history cannot certify achievement or become zero PnL',()=>{
 const r=review([],[],{histories:{}});assert.equal(r.status,'incomplete_evidence');assert.equal(r.totalEntries,null);assert.equal(r.modes.demo.entries,null);assert.equal(r.modes.demo.netRealizedUsdt,null);
});
test('before deadline remains collecting and formatting states true cutoff',()=>{
 const at=new Date(base+120000).toISOString(),histories=Object.fromEntries(['demo','demo-futures'].map(mode=>[mode,{source:'freqtrade-demo',historyComplete:true,trades:[],observedAt:at}]));
 const r=review([],[],{observedAt:at,histories});assert.equal(r.status,'collecting');assert.match(sprintMarkdown(r),/截止/);assert.match(sprintMarkdown(r),/原共同|共同本金/);
});
test('invalid scope, policy, or non-offset deadline cannot create a goal',()=>{
 for(const patch of [{target:{scope:'fake',count:100}},{deadline:'2026-09-15T08:00:00'},{deadline:startedAt},{entryPolicyVersion:'closed-price-momentum-v1'}])assert.throws(()=>review([],[],{goal:{...goal(),...patch}}),/SPRINT_GOAL_INVALID/);
});

test('prospective flow-only amendment counts honest non-model fills in a separate cohort and never backfills',()=>{
 const g={...goal(),entryPolicyVersion:'trend-pullback-flow-v1'},t=trade(1,{net:'-.4'});
 const pending={model:null,entryPolicyVersion:'order-flow-only-v1',entryRoute:'order-flow',entrySignalEngine:'sampled_order_flow',
  entryEvidence:{version:'order-flow-evidence-v1',snapshotId:snapshot(1),usedForEntryDecision:true,proofSha256:'d'.repeat(64)},
  riskPolicy:{version:'native-stop-risk-v1',mode:'demo',stopLimitRatio:'0.995',reserveFraction:'0.005'}};
 const journals={demo:journal(t,{pending}),'demo-futures':[]};
 const amendment={schemaVersion:1,goalId:g.id,goalSha256:createHash('sha256').update(JSON.stringify(g)).digest('hex'),entryPolicyVersion:'order-flow-only-v1',effectiveAt:new Date(base+10000).toISOString()};
 const r=review([t],[],{goal:g,journals,amendment});assert.equal(r.modes.demo.entries,1);assert.equal(r.modes.demo.netRealizedUsdt,'-0.4');assert.equal(r.modes.demo.trades[0].modelFingerprint,null);
 assert.equal(r.modes.demo.entryPolicyCohorts[0].entryPolicyVersion,'order-flow-only-v1');
 assert.equal(review([t],[],{goal:g,journals}).totalEntries,0);
 assert.equal(review([t],[],{goal:g,journals,amendment:{...amendment,effectiveAt:new Date(base+70000).toISOString()}}).totalEntries,0);
 assert.throws(()=>review([t],[],{goal:g,journals,amendment:{...amendment,goalSha256:'x'}}),/AMENDMENT_INVALID/);
 const bad=structuredClone(journals);bad.demo[0].entryEvidence.proofSha256=null;
 assert.equal(review([t],[],{goal:g,journals:bad,amendment}).evidenceComplete,false);
});

function flowPending(n,mode='demo',extra={}){
 return {model:null,entryPolicyVersion:'order-flow-only-v1',entryRoute:'order-flow',entrySignalEngine:'sampled_order_flow',
  entryEvidence:{version:'order-flow-evidence-v1',snapshotId:snapshot(n),usedForEntryDecision:true,proofSha256:'d'.repeat(64)},
  riskPolicy:{version:'native-stop-risk-v1',mode,stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'},...extra};
}
function flowGoal(){
 const g={...goal(),entryPolicyVersion:'trend-pullback-flow-v1',target:{scope:'each',count:100},deadline:new Date(base+240000).toISOString()};
 const amendment={schemaVersion:1,goalId:g.id,goalSha256:createHash('sha256').update(JSON.stringify(g)).digest('hex'),
  entryPolicyVersion:'order-flow-only-v1',effectiveAt:new Date(base+10000).toISOString()};
 return {goal:g,amendment};
}
const executionQuality='flow-price-continuation-v1';

test('rolling-confirmation cohort preserves earlier losses and only attributes new tagged fills',()=>{
 const old=trade(1,{net:'-.65'}),fresh=trade(2,{net:'-.15'}),options=flowGoal();
 const journals={demo:[...journal(old,{pending:flowPending(1,'demo',{executionQualityVersion:'flow-strength-exit-v1'})}),
  ...journal(fresh,{pending:flowPending(2,'demo',{executionQualityVersion:'flow-confirmed-exit-v2'})})],'demo-futures':[]};
 const before=JSON.stringify(journals),r=review([old,fresh],[],{...options,journals});
 assert.equal(r.evidenceComplete,true);assert.equal(r.totalEntries,2);assert.equal(r.modes.demo.netRealizedUsdt,'-0.8');
 assert.equal(JSON.stringify(journals),before);
 assert.deepEqual(r.modes.demo.executionQualityCohorts.map(c=>[c.executionQualityVersion,c.tradeIds,c.netRealizedUsdt]),
  [['flow-strength-exit-v1',[1],'-0.65'],['flow-confirmed-exit-v2',[2],'-0.15']]);
});

test('new strength and exit cohort retains continuation losses and unchanged goal totals',()=>{
 const old=trade(1,{net:'-.55'}),fresh=trade(2,{open:true,net:'-.1'}),options=flowGoal();
 const journals={demo:[...journal(old,{pending:flowPending(1,'demo',{executionQualityVersion:executionQuality})}),
  ...journal(fresh,{pending:flowPending(2,'demo',{executionQualityVersion:'flow-strength-exit-v1'})})],'demo-futures':[]};
 const r=review([old,fresh],[],{...options,journals});assert.equal(r.evidenceComplete,true);assert.equal(r.totalEntries,2);
 assert.equal(r.modes.demo.netRealizedUsdt,'-0.55');
 assert.deepEqual(r.modes.demo.executionQualityCohorts.map(c=>[c.executionQualityVersion,c.tradeIds,c.netRealizedUsdt]),
  [[executionQuality,[1],'-0.55'],['flow-strength-exit-v1',[2],'0']]);
});

test('sprint execution-quality cohorts use the same deadline scope and preserve totals without attributing old fills to new checks',()=>{
 const old=trade(1,{net:'-1.2'}),fresh=trade(2,{net:'.4'}),open=trade(3,{open:true,net:'-.1'}),late=trade(4,{net:'-5'}),
  future=trade(1,{mode:'demo-futures',short:true,net:'-.3'}),options=flowGoal();
 late.orders[0].order_filled_timestamp=base+240001;
 const journals={demo:[...journal(old,{pending:flowPending(1)}),...journal(fresh,{pending:flowPending(2,'demo',{executionQualityVersion:executionQuality})}),
  ...journal(open,{pending:flowPending(3,'demo',{executionQualityVersion:executionQuality})}),...journal(late,{pending:flowPending(4,'demo',{executionQualityVersion:executionQuality})})],
  'demo-futures':journal(future,{mode:'demo-futures',pending:flowPending(1,'demo-futures')})};
 const before=JSON.stringify({options,journals}),r=review([old,fresh,open,late],[future],{...options,journals}),s=r.modes.demo;
 assert.equal(JSON.stringify({options,journals}),before);assert.equal(r.totalEntries,4);assert.equal(s.entries,3);
 assert.equal(s.netRealizedUsdt,'-0.8');assert.equal(s.netUnrealizedUsdt,'-0.1');assert.equal(s.allHistory.netRealizedUsdt,'-5.8');
 assert.deepEqual(s.executionQualityCohorts.map(c=>[c.executionQualityVersion,c.entries,c.tradeIds,c.closedTrades,c.openTrades,c.netRealizedUsdt,c.netUnrealizedUsdt]),
  [['legacy-unrecorded',1,[1],1,0,'-1.2','0'],[executionQuality,2,[2,3],1,1,'0.4','-0.1']]);
 assert.deepEqual(r.modes['demo-futures'].executionQualityCohorts.map(c=>[c.executionQualityVersion,c.tradeIds,c.netRealizedUsdt]),[['not-applicable',[1],'-0.3']]);
 assert.ok(s.excluded.some(e=>e.tradeId===4&&e.reason==='ENTRY_FILL_AT_OR_AFTER_DEADLINE'));
 assert.match(sprintMarkdown(r),/策略調整 flow-price-continuation-v1：2 筆/);
 assert.match(sprintMarkdown(r),/不回填或重計舊交易/);
});

test('sprint surfaces invalid or conflicting execution-quality provenance instead of counting it in a new cohort',()=>{
 const t=trade(1),options=flowGoal();
 for(const value of ['forged',null]){
  const journals={demo:journal(t,{pending:flowPending(1,'demo',{executionQualityVersion:value})}),'demo-futures':[]};
  const r=review([t],[],{...options,journals});
  assert.equal(r.evidenceComplete,false);assert.equal(r.totalEntries,null);assert.equal(r.modes.demo.entries,0);
  assert.equal(r.modes.demo.executionQualityCohorts.length,0);
 }
 for(const pendingQuality of [undefined,executionQuality]){
  const pending=flowPending(1);if(pendingQuality!==undefined)pending.executionQualityVersion=pendingQuality;
  const journals={demo:journal(t,{pending,terminal:{executionQualityVersion:pendingQuality===undefined?executionQuality:'forged'}}),'demo-futures':[]};
  const r=review([t],[],{...options,journals});assert.equal(r.evidenceComplete,false);assert.equal(r.modes.demo.entries,0);
 }
 const future=trade(1,{mode:'demo-futures'}),r=review([],[future],{...options,journals:{demo:[],
  'demo-futures':journal(future,{mode:'demo-futures',pending:flowPending(1,'demo-futures',{executionQualityVersion:executionQuality})})}});
 assert.equal(r.evidenceComplete,false);assert.equal(r.modes['demo-futures'].entries,0);
});

test('execution-quality cohorts do not turn missing open profit into zero or crash an incomplete report',()=>{
 for(const net of [undefined,'unavailable',null]){
  const t=trade(1,{open:true});t.profit_abs=net;
  const r=review([t],[],{...flowGoal(),journals:{demo:journal(t,{pending:flowPending(1,'demo',{executionQualityVersion:executionQuality})}),'demo-futures':[]}});
  assert.equal(r.evidenceComplete,false);assert.equal(r.totalEntries,null);
  const c=r.modes.demo.executionQualityCohorts[0];assert.equal(c.entries,1);
  assert.equal(c.netUnrealizedUsdt,null);assert.equal(c.netRealizedUsdt,null);assert.equal(c.pnlComplete,false);
 }
});

const nativeStart='2026-09-16T02:00:00.000Z',nativeDeadline='2026-09-16T16:00:00.000Z',nativeObserved='2026-09-16T17:00:00.000Z';
const nativeGoal=()=>({...goal(),id:'2026-09-16-flow-only-50-each',startedAt:nativeStart,deadline:nativeDeadline,
 entryPolicyVersion:'order-flow-only-v1',modelFingerprint:null,target:{scope:'each',count:50}});
function nativeTrade(n,options={}){
 const t=trade(n,options),shift=Date.parse(nativeStart)-base;
 t.open_timestamp+=shift;if(t.close_timestamp!==null)t.close_timestamp+=shift;
 for(const order of t.orders)order.order_filled_timestamp+=shift;
 return t;
}
function nativeReview(spot=[],futures=[],options={}){
 const at=options.observedAt??nativeObserved;
 const histories=Object.fromEntries([['demo',spot],['demo-futures',futures]].map(([mode,trades])=>[mode,{source:'freqtrade-demo',historyComplete:true,observedAt:at,trades}]));
 const journals=Object.fromEntries([['demo',spot],['demo-futures',futures]].map(([mode,trades])=>[mode,trades.flatMap(t=>journal(t,{mode,pending:flowPending(t.trade_id,mode)}))]));
 return buildSprintReview({goal:nativeGoal(),histories,journals,observedAt:at,...options});
}

test('native flow goal reaches 50 actual entries in each mode without a forecast pin or amendment',()=>{
 const spot=Array.from({length:50},(_,i)=>nativeTrade(i+1,{net:'-.1',open:i%2===0}));
 const futures=Array.from({length:50},(_,i)=>nativeTrade(i+1,{mode:'demo-futures',short:i%2===0,net:'.2'}));
 const before=JSON.stringify({spot,futures}),r=nativeReview(spot,futures);
 assert.equal(r.completed,true);assert.equal(r.status,'complete');assert.equal(r.totalEntries,100);assert.equal(r.amendment,null);
 assert.equal(r.entryPolicyVersion,'order-flow-only-v1');assert.equal(r.modes.demo.entries,50);assert.equal(r.modes['demo-futures'].entries,50);
 assert.ok(r.modes.demo.trades.every(t=>t.modelFingerprint===null&&t.entrySignalEngine==='sampled_order_flow'));
 assert.equal(r.modes.demo.netRealizedUsdt,'-2.5');assert.equal(r.modes.demo.netUnrealizedUsdt,'-2.5');
 assert.equal(nativeReview(spot,futures.slice(0,49)).completed,false);
 assert.equal(nativeReview([...spot,nativeTrade(51)],futures.slice(0,49)).completed,false,'100 combined is not 50 each');
 assert.equal(JSON.stringify({spot,futures}),before);assert.equal(r.executionChanged,false);
 assert.match(sprintMarkdown(r),/現貨、合約各 50 筆/);
});

test('native flow excludes model-policy fills and earlier session openings without losing their visible loss',()=>{
 const flow=nativeTrade(1,{net:'-.4'}),model=nativeTrade(2,{net:'-3'}),old=nativeTrade(3,{net:'-9'});
 old.open_timestamp=Date.parse(nativeStart)-1;old.orders[0].order_filled_timestamp=old.open_timestamp;
 const journals={demo:[...journal(flow,{pending:flowPending(1)}),...journal(model),...journal(old,{pending:flowPending(3)})],'demo-futures':[]};
 const r=nativeReview([flow,model,old],[],{journals});
 assert.equal(r.evidenceComplete,true);assert.equal(r.totalEntries,1);assert.equal(r.modes.demo.netRealizedUsdt,'-0.4');
 assert.equal(r.modes.demo.allHistory.netRealizedUsdt,'-12.4');
 assert.ok(r.modes.demo.excluded.some(x=>x.reason==='OTHER_ENTRY_POLICY'));
 assert.ok(r.modes.demo.excluded.some(x=>x.reason==='OPENED_BEFORE_GOAL'));
});

test('native flow deadline is Taiwan midnight exclusive, including any late split fill',()=>{
 const deadline=Date.parse(nativeDeadline);
 for(const delta of [-1,0,1]){
  const t=nativeTrade(1);t.open_timestamp=deadline-2000;t.close_timestamp=deadline+30000;t.orders[0].order_filled_timestamp=deadline+delta;
  const r=nativeReview([t]);assert.equal(r.totalEntries,delta<0?1:0);
  if(delta>=0)assert.ok(r.modes.demo.excluded.some(x=>x.reason==='ENTRY_FILL_AT_OR_AFTER_DEADLINE'));
 }
 const split=nativeTrade(1);split.orders.push({...split.orders[0],order_id:'late-split',order_filled_timestamp:deadline});
 assert.equal(nativeReview([split]).totalEntries,0);
 const before=nativeReview([],[],{observedAt:'2026-09-16T15:59:59.999Z'});
 assert.equal(before.status,'collecting');assert.equal(nativeReview([],[],{observedAt:nativeDeadline}).status,'deadline_missed');
});

test('native flow retains mandatory actual fill, flow provenance, risk and immutable journal checks',()=>{
 for(const mutate of [x=>x.t.orders[0].filled=0,x=>x.t.orders[0].is_open=true,
  x=>x.j[0].entryEvidence.proofSha256=null,x=>x.j[0].riskPolicy=null,
  x=>x.j[0].entrySignalEngine='kronos_pretrained',x=>x.j[0].model={modelFingerprint:fingerprint},
  x=>x.j[1].entryPolicyVersion='forecast-net-edge-v1']){
  const t=nativeTrade(1),x={t,j:journal(t,{pending:flowPending(1)})};mutate(x);
  const r=nativeReview([t],[],{journals:{demo:x.j,'demo-futures':[]}});
  assert.equal(r.modes.demo.entries,0);assert.equal(r.evidenceComplete,false);assert.equal(r.completed,false);
 }
 const g=nativeGoal(),amendment={schemaVersion:1,goalId:g.id,goalSha256:createHash('sha256').update(JSON.stringify(g)).digest('hex'),entryPolicyVersion:'order-flow-only-v1',effectiveAt:nativeStart};
 assert.throws(()=>nativeReview([],[],{amendment}),/SPRINT_AMENDMENT_INVALID/);
});
