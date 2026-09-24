import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPortfolio,buildPortfolioReport,summarizePortfolioExposure,loadPortfolioConfig,validatePortfolioConfig,PORTFOLIO_DEFAULTS,PORTFOLIO_SOURCE} from '../src/portfolio.mjs';

const startedAt='2026-09-10T12:00:00.000Z',asOf='2026-09-10T13:00:00.000Z',now=Date.parse(asOf);
const modes=['demo','demo-futures'];
const config=()=>({...PORTFOLIO_DEFAULTS});
const history=()=>({demo:[],'demo-futures':[]});
const baseline=()=>({startedAt,source:'freqtrade-demo',historyCompleteByMode:{demo:true,'demo-futures':true},
 excludedTradeIdsByMode:{demo:[],'demo-futures':[]},tagAttributionByMode:{demo:{},'demo-futures':{}}});
function closed(id,pnl='1',mode='demo',extra={}){
 return {trade_id:id,pair:mode==='demo'?'ETH/USDT':'ETH/USDT:USDT',is_short:mode==='demo-futures',is_open:false,
  enter_tag:'codex-'+id,open_timestamp:Date.parse(startedAt)+id*60000,close_timestamp:Date.parse(startedAt)+id*60000+30000,
  profit_abs:pnl,stake_amount:50,leverage:1,fee_open_cost:'.025',fee_close_cost:'.025',...extra};
}
function position(id,mode='demo',extra={}){
 return closed(id,'0',mode,{is_open:true,close_timestamp:null,has_open_orders:false,amount:'.5',current_rate:100,
  trading_mode:mode==='demo'?'spot':'futures',...extra});
}
function report({histories=history(),marker=baseline(),samples=[],...extra}={}){
 for(const mode of modes)for(const trade of histories[mode]??[]){
  if(!marker.excludedTradeIdsByMode[mode].includes(trade.trade_id)&&!Object.hasOwn(marker.tagAttributionByMode[mode],trade.enter_tag))
   marker.tagAttributionByMode[mode][trade.enter_tag]={purpose:'strategy',version:'demo-rules-v6'};
 }
 return buildPortfolioReport({histories,baseline:marker,config:config(),asOf,samples,...extra});
}
function plan(pair='BTC/USDT',isShort=false,extra={}){
 return {pair,isShort,ruleVersion:'demo-rules-v6',stopFraction:'.009',riskCostFraction:'.001',riskBudgetUsdt:1,
  maxEntryNotionalUsdt:50,...extra};
}
function account(mode){
 return {observedAt:asOf,engine:{demo_trading:true,dry_run:false,exchange:'binance',trading_mode:mode==='demo'?'spot':'futures'},
  trades:[],daily:{stake_currency:'USDT',data:[{date:'2026-09-10',abs_profit:0}]},
  balance:{total:100000000,stake:'USDT',currencies:[{currency:'USDT',free:100000000}]}};
}
function guard(){
 return {proposal:{action:'buy',pair:'BTC/USDT',stakeUsdt:'50'},mode:'demo',accounts:{demo:account('demo'),'demo-futures':account('demo-futures')},
  plans:{},journalByMode:{demo:[],'demo-futures':[]},entryPlan:plan(),performance:report(),config:config(),now};
}
function add(g,trade,mode='demo',riskPlan={}){
 g.accounts[mode].trades.push(trade);g.plans[mode+':'+trade.trade_id]=plan(trade.pair,trade.is_short,riskPlan);return g;
}
const rejects=(value,code)=>assert.throws(()=>assessPortfolio(value),error=>error.message===code);

test('shared portfolio includes native stop reserve for new entries and marked open exposure',()=>{
 const riskPolicy={version:'native-stop-risk-v1',mode:'demo',stopLimitRatio:'0.995',reserveFraction:'0.005'};
 const g=guard();g.proposal.stakeUsdt='75';
 g.entryPlan=plan('BTC/USDT',false,{ruleVersion:'kronos-direction-v12',riskPolicy,maxEntryNotionalUsdt:75});
 rejects(g,'PORTFOLIO_PLAN_INVALID'); // 75 * (.009 + .001 + .005) > 1
 g.proposal.stakeUsdt='50';assessPortfolio(g);
 delete g.entryPlan.riskPolicy;
 assert.throws(()=>assessPortfolio(g),/DEMO_RISK_POLICY_INVALID/);
 const h=guard();h.config.maxOpenRiskUsdt='1';
 add(h,position(1,'demo',{stake_amount:75,amount:.75}), 'demo',{riskPolicy});
 assert.throws(()=>assessPortfolio(h),/PORTFOLIO/);
});

test('checked config fixes the shared budget and preserves hard guard ceilings',async()=>{
 assert.deepEqual(await loadPortfolioConfig(),config());
 for(const [name,value] of Object.entries({capitalUsdt:'2001',maxGrossExposureUsdt:'1051',maxOpenRiskUsdt:'10.01',maxDailyLossUsdt:'51',
  maxDrawdownUsdt:'101',maxSnapshotAgeSeconds:16,blockOppositeSameBase:false,version:2}))
  assert.throws(()=>validatePortfolioConfig({...config(),[name]:value}),/PORTFOLIO_CONFIG_INVALID/);
 for(const value of [null,true,'',Infinity,'1e999','-1','0'])assert.throws(()=>validatePortfolioConfig({...config(),capitalUsdt:value}),/PORTFOLIO_CONFIG_INVALID/);
 assert.equal(validatePortfolioConfig({...config(),maxDailyLossUsdt:'20'}).maxDailyLossUsdt,'20');
});

test('actual Demo balances never enlarge the shared $2000 budget',()=>{
 const g=guard(),result=assessPortfolio(g);
 assert.equal(result.capitalUsdt,'2000');assert.equal(result.budgetEquityUsdt,'2000');
 assert.equal(result.grossExposureAfterUsdt,'50');assert.equal(result.newEntryRiskUsdt,'0.5');
 g.accounts.demo.balance.total=1e20;g.accounts['demo-futures'].balance.total=1e20;
 assert.deepEqual(assessPortfolio(g),result);
});

test('positions from both modes use gross marked or original notional without netting',()=>{
 const g=guard();add(g,position(1,'demo',{pair:'ETH/USDT',stake_amount:50,amount:1,current_rate:150}));
 add(g,position(2,'demo-futures',{pair:'SOL/USDT:USDT',stake_amount:40,leverage:2,amount:1,current_rate:60}),'demo-futures');
 const result=assessPortfolio(g);
 assert.equal(result.grossExposureAfterUsdt,'280');assert.equal(result.allocatedMarginAfterUsdt,'140');
 assert.equal(result.openRiskAfterUsdt,'2.8');
 const exposure=summarizePortfolioExposure(g);assert.equal(exposure.grossUsdt,'230');assert.equal(exposure.estimatedOpenRiskUsdt,'2.3');
 g.accounts.demo.trades[0].current_rate=0;
 assert.throws(()=>summarizePortfolioExposure(g),/PORTFOLIO_POSITION_MARK_UNAVAILABLE/);
});

test('combined gross exposure is enforced across both engines',()=>{
 const g=guard();add(g,position(1,'demo',{stake_amount:900,amount:9,current_rate:100}), 'demo',{stopFraction:'.0001',riskCostFraction:0});
 add(g,position(2,'demo-futures',{pair:'SOL/USDT:USDT',stake_amount:150,amount:1.5,current_rate:100}),'demo-futures',{stopFraction:'.0001',riskCostFraction:0});
 rejects(g,'PORTFOLIO_GROSS_EXPOSURE_LIMIT');
});

test('combined persisted stop and cost risk is capped even while gross stays below cap',()=>{
 const g=guard();add(g,position(1,'demo',{stake_amount:200,amount:2,current_rate:100}),'demo',{stopFraction:'.02',riskCostFraction:'.03'});
 rejects(g,'PORTFOLIO_OPEN_RISK_LIMIT');
});

test('combined daily realized loss and actual open mark loss share one daily threshold',()=>{
 const g=guard();g.accounts.demo.daily.data[0].abs_profit='-20';g.accounts['demo-futures'].daily.data[0].abs_profit='-20';
 add(g,position(1,'demo',{profit_abs:'-10'}));rejects(g,'PORTFOLIO_DAILY_LOSS_LIMIT');
 g.accounts.demo.daily.data[0].abs_profit='-19.99999999';assert.equal(assessPortfolio(g).dailyNetUsdt,'-49.99999999');
});

test('positive signed daily outcomes offset losses without dropping current PnL',()=>{
 const g=guard();g.accounts.demo.daily.data[0].abs_profit='60';g.accounts['demo-futures'].daily.data[0].abs_profit='-100';
 add(g,position(1,'demo',{profit_abs:'-9'}));assert.equal(assessPortfolio(g).dailyNetUsdt,'-49');
});

test('opposite ETH directions conflict across modes; same direction is not netted',()=>{
 const g=guard();add(g,position(1));g.mode='demo-futures';g.proposal={action:'open-short',pair:'ETH/USDT:USDT',stakeUsdt:'50',leverage:1};
 g.entryPlan=plan(g.proposal.pair,true);rejects(g,'PORTFOLIO_OPPOSITE_POSITION');
 g.proposal.action='open-long';g.entryPlan.isShort=false;assert.equal(assessPortfolio(g).grossExposureAfterUsdt,'100');
 g.mode='demo';g.proposal={action:'buy',pair:'ETH/USDT',stakeUsdt:'50'};g.entryPlan=plan('ETH/USDT');rejects(g,'PORTFOLIO_DUPLICATE_POSITION');
});

test('missing or stale other engine state blocks fresh entry, including future timestamps',()=>{
 const g=guard();delete g.accounts['demo-futures'];rejects(g,'PORTFOLIO_ACCOUNT_UNAVAILABLE');
 for(const age of [15001,-1]){const v=guard();v.accounts['demo-futures'].observedAt=new Date(now-age).toISOString();rejects(v,'PORTFOLIO_ACCOUNT_STALE');}
 const v=guard();v.accounts.demo.engine.demo_trading=false;rejects(v,'PORTFOLIO_ACCOUNT_IDENTITY');
});

test('unresolved submissions in either mode are never retried or silently cleared',()=>{
 for(const status of ['pending','unknown']){
  const g=guard();g.journalByMode['demo-futures']=[{id:'a',status,at:asOf}];rejects(g,'PORTFOLIO_UNRESOLVED_SUBMISSION');
  g.journalByMode['demo-futures'].push({id:'a',status:'reconciled',at:asOf});assert.equal(assessPortfolio(g).checked,true);
 }
 const g=guard();g.journalByMode.demo=[{id:'a',status:'invented',at:asOf}];rejects(g,'PORTFOLIO_JOURNAL_INVALID');
});

test('missing risk plans, invalid marks, partial orders and daily data are fail closed',()=>{
 const g=guard();add(g,position(1));delete g.plans['demo:1'];rejects(g,'PORTFOLIO_PLAN_MISSING');
 for(const field of ['current_rate','amount','profit_abs'])for(const value of [null,'',Infinity,'NaN']){
  const v=guard();add(v,position(1,'demo',{[field]:value}));rejects(v,'PORTFOLIO_POSITION_MARK_UNAVAILABLE');
 }
 const partial=guard();add(partial,position(1,'demo',{has_open_orders:true}));rejects(partial,'PORTFOLIO_POSITION_INVALID');
 const daily=guard();daily.accounts.demo.daily.data=[];rejects(daily,'PORTFOLIO_DAILY_STATE_UNAVAILABLE');
 const missing=guard();delete missing.accounts.demo.daily.data[0].abs_profit;rejects(missing,'PORTFOLIO_DAILY_STATE_UNAVAILABLE');
});

test('drawdown breach stays latched when budget equity later recovers',()=>{
 const marker=baseline(),samples=[
  {source:PORTFOLIO_SOURCE,asOf:'2026-09-10T12:10:00Z',startedAt,capitalUsdt:'2000',evidenceComplete:true,budgetEquityUsdt:'2010'},
  {source:PORTFOLIO_SOURCE,asOf:'2026-09-10T12:20:00Z',startedAt,capitalUsdt:'2000',evidenceComplete:true,budgetEquityUsdt:'1900'}];
 const r=report({marker,samples});assert.equal(r.budgetEquityUsdt,'2000');assert.equal(r.sampledMaxDrawdownUsdt,'110');
 assert.equal(r.currentDrawdownUsdt,'10');assert.equal(r.drawdownLimitBreached,true);
 const g=guard();g.performance=r;rejects(g,'PORTFOLIO_DRAWDOWN_LIMIT');
});

test('capital allocation uses budget equity after actual losses, never exchange wallet equity',()=>{
 const lower={...config(),capitalUsdt:'100',maxGrossExposureUsdt:'100'},histories=history();histories.demo=[closed(1,'-1')];
 const g=guard();g.config=lower;g.proposal.stakeUsdt='100';g.entryPlan.maxEntryNotionalUsdt=100;
 g.performance=report({histories,config:lower});rejects(g,'PORTFOLIO_CAPITAL_LIMIT');
});

test('exit availability does not depend on portfolio marks or accounting being available',()=>{
 for(const action of ['hold','sell','close-short','close-long'])assert.equal(assessPortfolio({mode:'demo',proposal:{action},now}).checked,false);
});

test('realized and unrealized accounting stay separate and fees are never subtracted twice',()=>{
 const histories=history();histories.demo=[closed(1,'3'),position(2,'demo',{profit_abs:'-1'})];
 histories['demo-futures']=[closed(1,'-2','demo-futures')];const r=report({histories});
 assert.equal(r.evidenceComplete,true);assert.equal(r.netRealizedUsdt,'1');assert.equal(r.unrealizedUsdt,'-1');
 assert.equal(r.netPnlUsdt,'0');assert.equal(r.budgetEquityUsdt,'2000');assert.equal(r.returnPct,'0');
 assert.equal(r.total.engineFeesUsdt,'0.125');assert.equal(r.total.originalExchangeCommissions,null);
 assert.equal(r.executionCosts.actualSignedSlippageUsdt,null);
});

test('exact baseline exclusions include open trades but never remove exposure from guard',()=>{
 const histories=history(),marker=baseline(),old=position(1,'demo',{open_timestamp:Date.parse(startedAt)-1,profit_abs:'-500'});
 histories.demo=[old,closed(2,'2')];marker.excludedTradeIdsByMode.demo=[1];const r=report({histories,marker});
 assert.equal(r.netPnlUsdt,'2');assert.equal(r.budgetEquityUsdt,'2002');assert.equal(r.ignored[0].tradeId,1);
 const g=guard();add(g,old);rejects(g,'PORTFOLIO_DAILY_LOSS_LIMIT');
});

test('probes and strategy versions remain attributable without becoming strategy profits',()=>{
 const histories=history(),marker=baseline();histories.demo=[closed(1,'2'),closed(2,'-.1'),closed(3,'-1')];
 marker.tagAttributionByMode.demo={'codex-1':{purpose:'strategy',version:'v6'},'codex-2':{purpose:'execution_probe',version:'probe-v1'},
  'codex-3':{purpose:'strategy',version:'v5'}};
 const r=report({histories,marker});assert.equal(r.netPnlUsdt,'0.9');assert.equal(r.strategy.netPnlUsdt,'1');
 assert.equal(r.probes.netPnlUsdt,'-0.1');assert.equal(r.byVersion.length,3);assert.equal(r.byVersion.find(x=>x.version==='v6').netPnlUsdt,'2');
});

test('unknown tags, missing baseline IDs and partial history make totals incomplete',()=>{
 const histories=history();histories.demo=[closed(1,'20')];
 const r=buildPortfolioReport({histories,baseline:baseline(),asOf});assert.equal(r.evidenceComplete,false);assert.equal(r.netPnlUsdt,null);
 assert.ok(r.warnings.some(x=>x.code==='PORTFOLIO_TRADE_UNATTRIBUTED'));
 const marker=baseline();marker.excludedTradeIdsByMode.demo=[999];assert.ok(report({marker}).warnings.some(x=>x.code==='PORTFOLIO_BASELINE_TRADE_MISSING'));
 const partial=baseline();partial.historyCompleteByMode['demo-futures']=false;
 assert.equal(report({marker:partial}).budgetEquityUsdt,null);
 const g=guard();g.performance=r;rejects(g,'PORTFOLIO_PERFORMANCE_INCOMPLETE');
});

test('open missing PnL or marks cannot be represented as zero',()=>{
 for(const field of ['profit_abs','current_rate']){
  const histories=history();histories.demo=[position(1,'demo',{[field]:null})];const r=report({histories});
  assert.equal(r.evidenceComplete,false);assert.equal(r.unrealizedUsdt,null);assert.equal(r.budgetEquityUsdt,null);
 }
 const histories=history();histories.demo=[closed(1,null)];assert.equal(report({histories}).netRealizedUsdt,null);
});

test('drawdown sample timestamps, source and baseline may not be mixed or silently skipped',()=>{
 const sample=report().sample;
 for(const edit of [{startedAt:'2026-09-09T12:00:00.000Z'},{capitalUsdt:'100000'}, {evidenceComplete:false},
  {source:'full-account-equity'}, {asOf:'2026-09-10T14:00:00Z'}, {budgetEquityUsdt:null}]){
  const r=report({samples:[{...sample,...edit}]});assert.equal(r.evidenceComplete,false);assert.equal(r.sampledMaxDrawdownUsdt,null);
 }
 const duplicate=report({samples:[sample,sample]});assert.equal(duplicate.evidenceComplete,false);
 const stale=guard();stale.performance.asOf='2026-09-10T12:59:44Z';rejects(stale,'PORTFOLIO_PERFORMANCE_STALE');
});

test('slippage is measured only with filled quantity, actual average and fresh Demo quote evidence',()=>{
 const histories=history(),order={order_id:'o-1',filled:'.5',amount:'.5',average:'100.1',cost:'50.05',remaining:0,is_open:false,status:'closed',ft_order_side:'buy',ft_is_entry:true};
 const exit={...order,order_id:'o-2',average:102,cost:51,ft_order_side:'sell',ft_is_entry:false};
 histories.demo=[closed(1,'1','demo',{orders:[order,exit]})];
 const quote={pair:'ETH/USDT',side:'buy',source:'https://demo-api.binance.com',price:100,
  observedAt:'2026-09-10T12:01:00Z',submittedAt:'2026-09-10T12:01:01Z'};
 const executionQuotesByMode={demo:{'o-1':quote,'o-2':{...quote,side:'sell',price:'102.2'}}},r=report({histories,executionQuotesByMode});
 assert.equal(r.executionCosts.actualSignedSlippageUsdt,'0.15');assert.equal(r.netRealizedUsdt,'1');
 assert.equal(report({histories,executionQuotesByMode:{demo:{'o-1':{...quote,observedAt:'2026-09-10T12:00:00Z'}}}}).executionCosts.actualSignedSlippageUsdt,null);
 assert.equal(report({histories,executionQuotesByMode:{demo:{'o-1':{...quote,source:'https://api.binance.com'}}}}).executionCosts.actualSignedSlippageUsdt,null);
 histories.demo[0].orders=[order];assert.equal(report({histories,executionQuotesByMode}).executionCosts.actualSignedSlippageUsdt,null);
});
