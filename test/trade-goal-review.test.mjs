import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {entryId} from '../src/entry-identity.mjs';
import {buildTradeGoalReview,tradeGoalMarkdown} from '../scripts/trade-goal-review.mjs';

const startedAt='2026-09-14T02:58:25.478Z',base=Date.parse(startedAt),observedAt='2026-09-14T12:00:00Z';
const fingerprint='a'.repeat(64),prediction='b'.repeat(64),version='kronos-direction-v12';
const snapshot=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const intentId=n=>createHash('sha256').update(snapshot(n)).digest('hex').slice(0,32);

test('flow and original routes retain separate actual losses and reject missing route provenance',()=>{
 const a=trade(1,{net:'-.7'}),b=trade(2,{net:'.2'});
 const pending={entryPolicyVersion:'trend-pullback-flow-v1',strategyFingerprint:'d'.repeat(64)};
 const journals={demo:[...journal(a,{pending:{...pending,entryRoute:'pullback'}}),...journal(b,{pending:{...pending,entryRoute:'order-flow'}})],'demo-futures':[]};
 const r=review([a,b],[],{journals}).modes.demo;
 assert.equal(r.entries,2);assert.equal(r.netRealizedUsdt,'-0.5');
 assert.deepEqual(r.entryRouteCohorts.map(c=>[c.entryRoute,c.netRealizedUsdt]),[['pullback','-0.7'],['order-flow','0.2']]);
 delete journals.demo[0].entryRoute;
 const bad=review([a,b],[],{journals}).modes.demo;assert.equal(bad.evidenceComplete,false);assert.equal(bad.entries,1);
});
const goal=()=>({schemaVersion:1,id:'2026-09-14-v12-30-each',source:'freqtrade-demo',startedAt,
 ruleVersion:version,modelFingerprint:fingerprint,targetPerMode:30,deadline:null,
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
  tradeId:null,purpose:'strategy',ruleVersion:version,snapshotId,
  model:{modelFingerprint:fingerprint,predictionSha256:prediction,snapshotId,issuedAt:new Date(t.open_timestamp-1500).toISOString(),usedForEntryDecision:true},...pending},
 {id,at:new Date(t.open_timestamp+1000).toISOString(),status:'submitted',action,tradeId:t.trade_id,pair:t.pair,tag:t.enter_tag,...terminal}];
}
function review(spot=[],futures=[],options={}){
 const histories=Object.fromEntries([['demo',spot],['demo-futures',futures]].map(([mode,trades])=>[mode,
  {source:'freqtrade-demo',historyComplete:true,observedAt,trades}]));
 const journals={demo:spot.flatMap(t=>journal(t)), 'demo-futures':futures.flatMap(t=>journal(t,{mode:'demo-futures'}))};
 return buildTradeGoalReview({goal:goal(),histories,journals,observedAt,...options});
}

test('two actual different pair fills from one snapshot count independently with immutable execution identity',()=>{
 const ts=[trade(1),trade(2,{pair:'ETH/USDT'})],sid=snapshot(1),rows=[];
 for(const t of ts){
  const id=entryId(sid,t.pair,'per-pair-cycle-v1');t.enter_tag='codex-'+id;
  for(const o of t.orders){o.pair=t.pair;o.ft_order_tag=t.enter_tag;}
  const r=journal(t,{pending:{snapshotId:sid,executionPolicyVersion:'per-pair-cycle-v1'}});
  r[0].model.snapshotId=sid;rows.push(...r);
 }
 const r=review(ts,[],{journals:{demo:rows,'demo-futures':[]}});
 assert.equal(r.modes.demo.entries,2);assert.equal(r.modes.demo.evidenceComplete,true);
 rows[2].executionPolicyVersion='forged';
 const bad=review(ts,[],{journals:{demo:rows,'demo-futures':[]}});assert.ok(bad.modes.demo.entries<2);assert.equal(bad.modes.demo.evidenceComplete,false);
});

test('risk revision separates actual fee-adjusted results without resetting the 30-entry goal',()=>{
 const old=trade(1,{net:'-1.2'}),closed=trade(2,{net:'.4'}),open=trade(3,{open:true,net:'-.1'});
 const riskPolicy={version:'native-stop-risk-v1',mode:'demo',stopLimitRatio:'0.995',reserveFraction:'0.005'};
 const journals={demo:[...journal(old),...journal(closed,{pending:{riskPolicy,strategyFingerprint:'c'.repeat(64)}}),
  ...journal(open,{pending:{riskPolicy,strategyFingerprint:'c'.repeat(64)}})],'demo-futures':[]};
 const r=review([old,closed,open],[],{journals}).modes.demo;
 assert.equal(r.entries,3);assert.equal(r.netRealizedUsdt,'-0.8');assert.equal(r.netUnrealizedUsdt,'-0.1');
 assert.deepEqual(r.riskCohorts.map(c=>[c.riskPolicyVersion,c.entries,c.netRealizedUsdt,c.netUnrealizedUsdt]),
  [['legacy-unrecorded',1,'-1.2','0'],['native-stop-risk-v1',2,'0.4','-0.1']]);
 journals.demo[2].riskPolicy={...riskPolicy,reserveFraction:'0'};
 const bad=review([old,closed,open],[],{journals}).modes.demo;
 assert.equal(bad.evidenceComplete,false);assert.ok(bad.warnings.some(w=>w.code==='RISK_ATTRIBUTION_MISMATCH'));
});

test('each actual strategy trade counts once, including open entries; realized and floating stay separate',()=>{
 const r=review([trade(1,{net:'-0.4',fee_open_cost:10,fee_close_cost:10}),trade(2,{open:true,net:'2.75'})],
  [trade(1,{mode:'demo-futures',short:true,open:true,net:'-0.1'})]);
 assert.equal(r.modes.demo.entries,2);assert.equal(r.modes.demo.closedTrades,1);assert.equal(r.modes.demo.openTrades,1);
 assert.equal(r.modes.demo.netRealizedUsdt,'-0.4');assert.equal(r.modes.demo.netUnrealizedUsdt,'2.75');
 assert.equal(r.modes['demo-futures'].entries,1);assert.equal(r.modes['demo-futures'].trades[0].direction,'short');
 assert.equal(r.modes.demo.remaining,28);assert.equal(r.status,'collecting');assert.equal(r.completed,false);
 assert.deepEqual(r.modes.demo.warnings,[]);
});

test('split completed entry fills, repeated order components and native stop exits never add entries',()=>{
 const t=trade(1),first={...t.orders[0],filled:0.4,cost:20},second={...t.orders[0],order_id:'part-two',filled:0.6,cost:30};
 t.orders=[first,{...first},second,{...first,order_id:'stop-exit',ft_is_entry:false,ft_order_side:'stoploss',ft_order_tag:'stoploss'}];
 t.nr_of_successful_exits=0;
 const r=review([t]);assert.equal(r.modes.demo.entries,1);assert.equal(r.modes.demo.closedTrades,1);
 assert.deepEqual(r.modes.demo.trades[0].entryOrderIds,['entry-1','part-two']);assert.equal(r.status,'collecting');
});

test('compact current-position orders without ft_is_entry still prove a filled entry',()=>{
 const t=trade(1,{open:true});delete t.orders[0].ft_is_entry;
 assert.equal(review([t]).modes.demo.entries,1);
});

test('order fill may precede trade creation and position amount may exclude base fee',()=>{
 const t=trade(1,{open:true,amount:0.999});
 assert.ok(t.orders[0].order_filled_timestamp<t.open_timestamp);
 assert.equal(review([t]).modes.demo.entries,1);
});

test('identical history duplicates count once but cannot certify completion',()=>{
 const t=trade(1),g=goal();g.targetPerMode=1;
 const r=review([t,structuredClone(t)],[],{goal:g,journals:{demo:journal(t),'demo-futures':[]}});
 assert.equal(r.modes.demo.entries,1);assert.equal(r.modes.demo.countComplete,false);assert.equal(r.modes.demo.complete,false);
 assert.ok(r.modes.demo.warnings.some(w=>w.code==='DUPLICATE_HISTORY_TRADE_ID'));
});

test('conflicting duplicate trade ids are excluded entirely',()=>{
 const t=trade(1),r=review([t,{...t,profit_abs:'900'}],[],{journals:{demo:journal(t),'demo-futures':[]}});
 assert.equal(r.modes.demo.entries,0);assert.equal(r.status,'incomplete_evidence');
});

test('baseline, old-time, old-version and execution-probe trades do not fill the new quota; old losses remain',()=>{
 const baseline=trade(1,{net:'-4'}),old=trade(2,{net:'-3',open_timestamp:base-100000,close_timestamp:base-50000}),
  other=trade(3,{net:'-2'}),probe=trade(4,{net:'-1'}),fresh=trade(5,{net:'0.5'}),g=goal();
 g.modes.demo={excludedTradeIds:[1],baselineTradeCount:1};
 const r=review([baseline,old,other,probe,fresh],[],{goal:g,journals:{demo:[...journal(baseline),...journal(old),
  ...journal(other,{pending:{ruleVersion:'guarded-forward-v10'}}),...journal(probe,{pending:{purpose:'execution_probe'}}),...journal(fresh)],'demo-futures':[]}});
 assert.equal(r.modes.demo.entries,1);assert.equal(r.modes.demo.netRealizedUsdt,'0.5');
 assert.equal(r.modes.demo.allHistory.netRealizedUsdt,'-9.5');assert.equal(r.status,'collecting');
 assert.deepEqual(r.modes.demo.excluded.map(t=>t.reason),['BASELINE_TRADE','OPENED_BEFORE_GOAL','OTHER_STRATEGY_VERSION','EXECUTION_PROBE']);
});

test('v11 goal remains readable and each explicit version counts only its own host journal entries',()=>{
 const old=trade(1,{net:'-2'}),fresh=trade(2,{net:'.5'}),oldVersion='kronos-forward-v11',
  oldGoal={...goal(),id:'2026-09-14-v11-30-each',ruleVersion:oldVersion},
  journals={demo:[...journal(old,{pending:{ruleVersion:oldVersion}}),...journal(fresh)],'demo-futures':[]};
 const before=JSON.stringify(oldGoal),legacy=review([old,fresh],[],{goal:oldGoal,journals}),
  current=review([old,fresh],[],{journals});
 assert.equal(JSON.stringify(oldGoal),before);
 assert.equal(legacy.ruleVersion,oldVersion);assert.equal(legacy.modes.demo.entries,1);
 assert.equal(legacy.modes.demo.trades[0].tradeId,1);assert.equal(legacy.modes.demo.netRealizedUsdt,'-2');
 assert.equal(current.ruleVersion,version);assert.equal(current.modes.demo.entries,1);
 assert.equal(current.modes.demo.trades[0].tradeId,2);assert.equal(current.modes.demo.netRealizedUsdt,'0.5');
 for(const result of [legacy,current]){
  assert.equal(result.modes.demo.allHistory.netRealizedUsdt,'-1.5');
  assert.equal(result.modes.demo.excluded[0].reason,'OTHER_STRATEGY_VERSION');
  assert.equal(result.status,'collecting');
 }
 assert.match(tradeGoalMarkdown(legacy),/^# v11 DEMO/);
 assert.match(tradeGoalMarkdown(current),/^# v12 DEMO/);
});

test('unfilled and unsettled partial orders cannot count',()=>{
 for(const orderPatch of [{filled:0,cost:0,status:'open',is_open:true,remaining:1},
  {filled:0.5,cost:25,status:'open',is_open:true,remaining:0.5}]){
  const t=trade(1,{open:true});Object.assign(t.orders[0],orderPatch);const r=review([t]);
  assert.equal(r.modes.demo.entries,0);assert.equal(r.status,'incomplete_evidence');
 }
});

test('terminal partial fills produce an actual position and count once after quantity validation',()=>{
 for(const status of ['canceled','cancelled','expired']){
  const t=trade(1,{open:true});Object.assign(t.orders[0],{status,filled:0.5,cost:25,remaining:0.5,amount:1,is_open:false});
  assert.equal(review([t]).modes.demo.entries,1);
  t.orders[0].remaining=0.25;
  assert.equal(review([t]).modes.demo.entries,0);
 }
});

test('model snapshot must be present as a UUID and hash to the journal intent ID',()=>{
 const t=trade(1),j=journal(t);
 for(const snapshotId of [undefined,null,'not-a-uuid',snapshot(2)]){
  const bad={...j[0],snapshotId,model:{...j[0].model,snapshotId}};
  assert.equal(review([t],[],{journals:{demo:[bad,j[1]],'demo-futures':[]}}).modes.demo.entries,0);
 }
});

test('rejected or unknown submissions never count; exact reconciliation can settle an unknown',()=>{
 const t=trade(1),j=journal(t);
 for(const status of ['rejected','unknown']){
  const r=review([t],[],{journals:{demo:[j[0],{...j[1],status}],'demo-futures':[]}});
  assert.equal(r.modes.demo.entries,0);assert.equal(r.modes.demo.complete,false);
 }
 const r=review([t],[],{journals:{demo:[j[0],{id:j[0].id,at:j[1].at,status:'unknown'},
  {...j[1],at:new Date(t.open_timestamp+2000).toISOString(),status:'reconciled'}],'demo-futures':[]}});
 assert.equal(r.modes.demo.entries,1);assert.equal(r.modes.demo.evidenceComplete,true);
});

test('missing pending attribution and mismatched model fingerprint or decision use are excluded',()=>{
 const t=trade(1),j=journal(t);
 for(const rows of [[j[1]],[{...j[0],model:{...j[0].model,modelFingerprint:'c'.repeat(64)}},j[1]],
  [{...j[0],model:{...j[0].model,usedForEntryDecision:false}},j[1]]]){
  const r=review([t],[],{journals:{demo:rows,'demo-futures':[]}});
  assert.equal(r.modes.demo.entries,0);assert.equal(r.modes.demo.evidenceComplete,false);
 }
});

test('journal identity, immutable model mutation, duplicate pending and ambiguous intents block attribution',()=>{
 const t=trade(1),j=journal(t),otherId='f'.repeat(32);
 for(const rows of [[j[0],{...j[1],pair:'ETH/USDT'}],[j[0],{...j[1],model:{...j[0].model,predictionSha256:'d'.repeat(64)}}],
  [j[0],{...j[0]},j[1]],[...j,...j.map(row=>({...row,id:otherId}))]]){
  const r=review([t],[],{journals:{demo:rows,'demo-futures':[]}});
  assert.equal(r.modes.demo.entries,0);assert.equal(r.modes.demo.complete,false);
 }
});

test('new submitted intent missing from history and unresolved current intent block completion',()=>{
 const t=trade(1),j=journal(t);
 for(const rows of [j,[j[0]]]){
  const r=review([],[],{journals:{demo:rows,'demo-futures':[]}});
  assert.equal(r.modes.demo.entries,0);assert.equal(r.modes.demo.evidenceComplete,false);
 }
});

test('both modes require complete source-attested current histories and journals',()=>{
 for(const history of [undefined,[],{source:'dry-run',historyComplete:true,observedAt,trades:[]},
  {source:'freqtrade-demo',historyComplete:false,observedAt,trades:[]},
  {source:'freqtrade-demo',historyComplete:true,observedAt:'2026-09-13T00:00:00Z',trades:[]}]){
  const r=review([],[],{histories:{demo:history}});
  assert.equal(r.modes.demo.entries,null);assert.equal(r.completed,false);assert.equal(r.status,'unavailable');
 }
 const r=review([],[],{journals:{}});assert.equal(r.modes.demo.entries,null);assert.equal(r.status,'unavailable');
});

test('source warnings and a vanished baseline cannot be silently certified',()=>{
 const h={source:'freqtrade-demo',historyComplete:true,observedAt,trades:[],warnings:['partial exchange fill metadata']};
 let r=review([],[],{histories:{demo:h,'demo-futures':{...h,warnings:[]}}});
 assert.equal(r.modes.demo.evidenceComplete,false);assert.equal(r.modes.demo.warnings[0].sourceWarning,'partial exchange fill metadata');
 const g=goal();g.modes.demo={excludedTradeIds:[99],baselineTradeCount:1};r=review([],[],{goal:g});
 assert.ok(r.modes.demo.warnings.some(w=>w.code==='BASELINE_HISTORY_MISSING'));
});

test('unattributed trades, wrong direction, wrong pair and conflicting fill IDs cannot count',()=>{
 const t=trade(1);
 const unknown=review([t],[],{journals:{demo:[],'demo-futures':[]}});assert.equal(unknown.modes.demo.entries,0);
 for(const change of [x=>{x.is_short=true;},x=>{x.orders[0].pair='ETH/USDT';},
  x=>{x.orders.push({...x.orders[0],cost:70});},x=>{x.ruleVersion='other';}]){
  const changed=structuredClone(t);change(changed);
  assert.equal(review([changed]).modes.demo.entries,0);
 }
});

test('all 30 in each separate mode is complete; 30 combined or 29 in one mode is not',()=>{
 const spot=Array.from({length:30},(_,n)=>trade(n+1,{open:n%2===0}));
 const futures=Array.from({length:30},(_,n)=>trade(n+1,{mode:'demo-futures',short:n%2===0}));
 const complete=review(spot,futures);
 assert.equal(complete.completed,true);assert.equal(complete.status,'complete');
 assert.equal(complete.modes.demo.entries,30);assert.equal(complete.modes['demo-futures'].entries,30);
 assert.equal(review(spot,futures.slice(0,29)).completed,false);
 assert.equal(review(spot.slice(0,15),futures.slice(0,15)).completed,false);
 assert.equal(complete.promotionAuthorized,false);assert.equal(complete.executionChanged,false);
});

test('future journal timestamps or reordered terminal-before-pending cannot certify a trade',()=>{
 const t=trade(1),j=journal(t);
 for(const rows of [[j[0],{...j[1],at:'2026-09-15T00:00:00Z'}],[j[1],j[0]]]){
  assert.equal(review([t],[],{journals:{demo:rows,'demo-futures':[]}}).modes.demo.entries,0);
 }
});

test('invalid goal or duplicate baseline markers are rejected',()=>{
 for(const patch of [{source:'live'},{modelFingerprint:'x'},{deadline:'2026-09-14T23:59:59Z'},{targetPerMode:0},
  ...['kronos-direction-v13','kronos-forward-v11/experiment','atr15m-forward-v10'].map(ruleVersion=>({ruleVersion})),
  {modes:{...goal().modes,demo:{excludedTradeIds:[1,1],baselineTradeCount:2}}}]){
  assert.throws(()=>review([],[],{goal:{...goal(),...patch}}),/TRADE_GOAL_INVALID/);
 }
});

test('markdown explicitly labels count, floating values and unavailable current results',()=>{
 const normal=tradeGoalMarkdown(review([trade(1,{open:true})]));assert.match(normal,/1 \/ 30/);assert.match(normal,/浮動/);
 const failed=tradeGoalMarkdown({status:'unavailable',observedAt,error:'HISTORY_UNAVAILABLE'});
 assert.match(failed,/HISTORY_UNAVAILABLE/);assert.match(failed,/前次結果不視為目前狀態/);
});


test('entry policy cohorts retain all actual losses and original count, and reject altered attribution',()=>{
 const old=trade(1,{net:'-1.2'}),fresh=trade(2,{net:'.4'});
 const journals={demo:[...journal(old),...journal(fresh,{pending:{entryPolicyVersion:'closed-price-momentum-v1',strategyFingerprint:'c'.repeat(64)}})],'demo-futures':[]};
 const r=review([old,fresh],[],{journals}).modes.demo;
 assert.equal(r.entries,2);assert.equal(r.netRealizedUsdt,'-0.8');
 assert.deepEqual(r.entryPolicyCohorts.map(c=>[c.entryPolicyVersion,c.entries,c.netRealizedUsdt]),
  [['direction-only-v12',1,'-1.2'],['closed-price-momentum-v1',1,'0.4']]);
 journals.demo[3].entryPolicyVersion='forged';
 assert.equal(review([old,fresh],[],{journals}).modes.demo.evidenceComplete,false);
});

test('net-edge cohort keeps older policies and original losses separately',()=>{
 const trades=[trade(1,{net:'-1.2'}),trade(2,{net:'-.4'}),trade(3,{net:'.1'})];
 const journals={demo:[...journal(trades[0]),...journal(trades[1],{pending:{entryPolicyVersion:'closed-price-momentum-v1',strategyFingerprint:'c'.repeat(64)}}),...journal(trades[2],{pending:{entryPolicyVersion:'forecast-net-edge-v1',strategyFingerprint:'d'.repeat(64)}})],'demo-futures':[]};
 const r=review(trades,[],{journals}).modes.demo;
 assert.equal(r.entries,3);assert.equal(r.netRealizedUsdt,'-1.5');assert.equal(r.evidenceComplete,true);
 assert.deepEqual(r.entryPolicyCohorts.map(c=>[c.entryPolicyVersion,c.netRealizedUsdt]),[['direction-only-v12','-1.2'],['closed-price-momentum-v1','-0.4'],['forecast-net-edge-v1','0.1']]);
});


test('pullback experiment has its own cohort while preserving all earlier fills and losses',()=>{
 const old=trade(1,{net:'-1.2'}),fresh=trade(2,{net:'-.3'});
 const journals={demo:[...journal(old),...journal(fresh,{pending:{entryPolicyVersion:'trend-pullback-model-v1',strategyFingerprint:'e'.repeat(64)}})],'demo-futures':[]};
 const r=review([old,fresh],[],{journals}).modes.demo;
 assert.equal(r.entries,2);assert.equal(r.evidenceComplete,true);assert.equal(r.netRealizedUsdt,'-1.5');
 assert.deepEqual(r.entryPolicyCohorts.map(c=>[c.entryPolicyVersion,c.entries,c.netRealizedUsdt]),[['direction-only-v12',1,'-1.2'],['trend-pullback-model-v1',1,'-0.3']]);
});

function flowPending(n,mode='demo',extra={}){
 return {model:null,entryPolicyVersion:'order-flow-only-v1',entryRoute:'order-flow',entrySignalEngine:'sampled_order_flow',strategyFingerprint:'e'.repeat(64),
  entryEvidence:{version:'order-flow-evidence-v1',snapshotId:snapshot(n),usedForEntryDecision:true,proofSha256:'d'.repeat(64)},
  riskPolicy:{version:'native-stop-risk-v1',mode,stopLimitRatio:mode==='demo'?'0.995':null,reserveFraction:mode==='demo'?'0.005':'0'},...extra};
}
const executionQuality='flow-price-continuation-v1';

test('spot execution-quality cohorts preserve original counts, actual losses, floating and absent historical attribution',()=>{
 const old=trade(1,{net:'-1.2'}),fresh=trade(2,{net:'.4'}),open=trade(3,{open:true,net:'-.1'}),future=trade(1,{mode:'demo-futures',short:true,net:'-.3'});
 const g={...goal(),allowOrderFlowOnly:true},journals={demo:[...journal(old,{pending:flowPending(1)}),
  ...journal(fresh,{pending:flowPending(2,'demo',{executionQualityVersion:executionQuality})}),
  ...journal(open,{pending:flowPending(3,'demo',{executionQualityVersion:executionQuality})})],
  'demo-futures':journal(future,{mode:'demo-futures',pending:flowPending(1,'demo-futures')})};
 const before=JSON.stringify({g,journals}),report=review([old,fresh,open],[future],{goal:g,journals}),r=report.modes.demo;
 assert.equal(JSON.stringify({g,journals}),before);assert.equal(r.entries,3);assert.equal(r.remaining,27);
 assert.equal(r.netRealizedUsdt,'-0.8');assert.equal(r.netUnrealizedUsdt,'-0.1');assert.equal(r.evidenceComplete,true);
 assert.deepEqual(r.executionQualityCohorts.map(c=>[c.executionQualityVersion,c.entries,c.tradeIds,c.closedTrades,c.openTrades,c.netRealizedUsdt,c.netUnrealizedUsdt]),
  [['legacy-unrecorded',1,[1],1,0,'-1.2','0'],[executionQuality,2,[2,3],1,1,'0.4','-0.1']]);
 assert.deepEqual(r.trades.map(t=>t.executionQualityVersion),['legacy-unrecorded',executionQuality,executionQuality]);
 assert.equal(report.modes['demo-futures'].executionQualityCohorts[0].executionQualityVersion,'not-applicable');
 assert.equal(report.modes['demo-futures'].netRealizedUsdt,'-0.3');
 assert.match(tradeGoalMarkdown(report),/策略調整 flow-price-continuation-v1：2 筆/);
 assert.match(tradeGoalMarkdown(report),/不回填舊成交/);
});

test('execution-quality attribution rejects unknown, null, wrong mode and non-flow policy',()=>{
 const g={...goal(),allowOrderFlowOnly:true};
 for(const value of ['forged',null,0,{},'not-applicable','legacy-unrecorded']){
  const t=trade(1),journals={demo:journal(t,{pending:flowPending(1,'demo',{executionQualityVersion:value})}),'demo-futures':[]};
  const r=review([t],[],{goal:g,journals}).modes.demo;
  assert.equal(r.entries,0);assert.ok(r.warnings.some(w=>w.code==='EXECUTION_QUALITY_ATTRIBUTION_MISMATCH'));
 }
 const future=trade(1,{mode:'demo-futures'}),f=review([],[future],{goal:g,journals:{demo:[],
  'demo-futures':journal(future,{mode:'demo-futures',pending:flowPending(1,'demo-futures',{executionQualityVersion:executionQuality})})}}).modes['demo-futures'];
 assert.equal(f.entries,0);assert.ok(f.warnings.some(w=>w.code==='EXECUTION_QUALITY_ATTRIBUTION_MISMATCH'));
 const t=trade(1),nonFlow=review([t],[],{journals:{demo:journal(t,{pending:{executionQualityVersion:executionQuality}}),'demo-futures':[]}}).modes.demo;
 assert.equal(nonFlow.entries,0);assert.ok(nonFlow.warnings.some(w=>w.code==='EXECUTION_QUALITY_ATTRIBUTION_MISMATCH'));
});

test('terminal rows may repeat execution-quality attribution but cannot alter, null or add it after the pending intent',()=>{
 const t=trade(1),g={...goal(),allowOrderFlowOnly:true};
 const valid=journal(t,{pending:flowPending(1,'demo',{executionQualityVersion:executionQuality}),terminal:{executionQualityVersion:executionQuality}});
 assert.equal(review([t],[],{goal:g,journals:{demo:valid,'demo-futures':[]}}).modes.demo.entries,1);
 for(const terminalValue of ['forged',null]){
  const bad=structuredClone(valid);bad[1].executionQualityVersion=terminalValue;
  const r=review([t],[],{goal:g,journals:{demo:bad,'demo-futures':[]}}).modes.demo;
  assert.equal(r.entries,0);assert.equal(r.evidenceComplete,false);
 }
 const introduced=journal(t,{pending:flowPending(1),terminal:{executionQualityVersion:executionQuality}});
 const r=review([t],[],{goal:g,journals:{demo:introduced,'demo-futures':[]}}).modes.demo;
 assert.equal(r.entries,0);assert.equal(r.evidenceComplete,false);
});

test('native flow goal requires explicit non-model identity and counts only its own policy without legacy enable flag',()=>{
 const g={...goal(),entryPolicyVersion:'order-flow-only-v1',modelFingerprint:null,targetPerMode:50};
 const flow=trade(1,{net:'-.4'}),model=trade(2,{net:'-2'}),journals={demo:[...journal(flow,{pending:flowPending(1)}),...journal(model)],'demo-futures':[]};
 const r=review([flow,model],[],{goal:g,journals});
 assert.equal(r.entryPolicyVersion,'order-flow-only-v1');assert.equal(r.modelFingerprint,null);assert.equal(r.modes.demo.entries,1);
 assert.equal(r.modes.demo.remaining,49);assert.equal(r.modes.demo.evidenceComplete,true);assert.equal(r.modes.demo.netRealizedUsdt,'-0.4');
 assert.equal(r.modes.demo.allHistory.netRealizedUsdt,'-2.4');assert.equal(r.modes.demo.excluded[0].reason,'OTHER_ENTRY_POLICY');
 for(const modelFingerprint of [undefined,fingerprint,'bad'])assert.throws(()=>review([],[],{goal:{...g,modelFingerprint}}),/TRADE_GOAL_INVALID/);
 assert.throws(()=>review([],[],{goal:{...goal(),modelFingerprint:null}}),/TRADE_GOAL_INVALID/);
 assert.match(r.limitations[0],/^50 entries/);
});
