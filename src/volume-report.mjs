import Decimal from 'decimal.js';
import {evaluatePerformance} from './performance.mjs';
import {VOLUME_ARMS,VOLUME_DURATION_MS,VOLUME_BLOCK_MS,VOLUME_EXPERIMENT_VERSION,
 validateVolumeConfig,validateVolumeAssignment,volumeAssignment,volumeVariant,isVolumeVariant} from './volume-experiment.mjs';

// Actual fills only: rejected signals never acquire hypothetical PnL.
export function buildVolumeReport({report,trades,journal,config,asOf}){
 const c=validateVolumeConfig(config),start=Date.parse(c.startAt),end=start+VOLUME_DURATION_MS,now=Date.parse(asOf);
 if(!Number.isFinite(now)||!Array.isArray(trades)||!Array.isArray(journal))throw Error('VOLUME_REPORT_INPUT_INVALID');
 const refs=new Set((report.strategy?.trades??[]).map(t=>t.tag)),warnings=[];
 const groups=new Map(VOLUME_ARMS.map(a=>[a.arm,{...a,trades:[],decisions:0}]));
 const outside=[];
 const intents=journal.filter(r=>r.status==='pending'&&['buy','open-long','open-short'].includes(r.action));
 for(const r of journal.filter(r=>r.status==='hold'||r.status==='pending')){
  if(!r.volumeExperiment)continue;
  try{
   const a=validateVolumeAssignment(r.volumeExperiment,r.volumeExperiment.candleBoundary);
   if(a.startAt===new Date(start).toISOString())groups.get(a.arm).decisions++;
  }catch{warnings.push({code:'EXPERIMENT_JOURNAL_INVALID',id:r.id});}
 }
 for(const t of trades.filter(t=>refs.has(t.enter_tag))){
  const matches=intents.filter(r=>r.tag===t.enter_tag&&r.pair===t.pair);
  if(matches.length!==1){warnings.push({code:'EXPERIMENT_ENTRY_AMBIGUOUS',tradeId:t.trade_id});continue;}
  const r=matches[0];
  if(!r.volumeExperiment){
   if(isVolumeVariant(r.ruleVersion))warnings.push({code:'EXPERIMENT_ATTRIBUTION_MISSING',tradeId:t.trade_id});
   else outside.push(t);
   continue;
  }
  try{
   const a=validateVolumeAssignment(r.volumeExperiment,r.volumeExperiment.candleBoundary);
   if(r.ruleVersion!==volumeVariant(a))throw Error('VARIANT_MISMATCH');
   if(a.startAt!==new Date(start).toISOString()){outside.push(t);continue;}
   groups.get(a.arm).trades.push(t);
  }catch{warnings.push({code:'EXPERIMENT_ATTRIBUTION_INVALID',tradeId:t.trade_id});}
 }
 const complete=report.validation?.evidenceComplete===true&&warnings.length===0;
 const arms=[...groups.values()].map(g=>{
  const evaluation=evaluatePerformance({trades:g.trades,mode:report.mode,observedAt:asOf}),s=evaluation.summary;
  const closed=g.trades.filter(t=>t.is_open===false),open=g.trades.filter(t=>t.is_open===true);
  let fee=new Decimal(0),feesComplete=true;
  for(const t of closed)for(const side of ['open','close']){
   const v=t['fee_'+side+'_cost'];
   if(!['number','string'].includes(typeof v)||String(v).trim()===''){feesComplete=false;continue;}
   try{const n=new Decimal(v);if(!n.isFinite()||n.lt(0))throw Error();fee=fee.plus(n);}catch{feesComplete=false;}
  }
  const valid=complete&&s.pnlComplete;
  return {arm:g.arm,minimum:g.minimum,variant:volumeVariant(g),journaledDecisions:g.decisions,
   openTrades:open.length,closedTrades:s.closedTrades,tradeIds:g.trades.map(t=>t.trade_id),pnlComplete:valid,
   netRealizedUsdt:valid?s.netRealizedUsdt:null,averageNetUsdt:valid?s.expectancyUsdt:null,
   profitFactor:valid?s.profitFactor:null,closedTradeDrawdownUsdt:valid?s.closedTradeDrawdownUsdt:null,
   recordedClosedTradeFeesUsdt:feesComplete&&valid?fee.toFixed():null,
   stopExitCount:closed.filter(t=>['rules_stop','stoploss_on_exchange','trailing_stop_loss'].includes(t.exit_reason)).length,
   status:!valid?'incomplete_evidence':s.closedTrades===0?'awaiting_closed_trades':s.closedTrades<30?'collecting_sample':'descriptive_sample_available'};
 });
 return {version:VOLUME_EXPERIMENT_VERSION,mode:report.mode,asOf,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),
  blockHours:VOLUME_BLOCK_MS/3600000,phase:!c.enabled?'disabled':now<start?'scheduled':now<end?'running':'window_complete',
  current:volumeAssignment(Math.floor(now/300000)*300000,c),arms,outsideExperimentTradeIds:outside.map(t=>t.trade_id),
  evidenceComplete:complete&&arms.every(a=>a.pnlComplete),warnings,winner:null,promotionAuthorized:false,
  limitations:['Only the confirmation-bar relative-volume minimum changes; price, exits and monetary risk remain fixed.',
   'Six-hour blocks rotate 0.8, 1.0, 1.2 for 72 hours. Five-minute signal checks continue. The schedule then returns to baseline 0.8.',
   'Time blocks are not independent randomized portfolios: regimes and positions carried across blocks can affect opportunity counts.',
   'Closed-trade drawdown excludes intratrade unrealized losses; monitor shared portfolio equity drawdown separately.',
   'Engine net fills already include recorded fees/funding. Fees shown here are descriptive, not deducted twice.',
   'No winner is selected automatically. Short samples, higher entry counts or a single best parameter do not validate profitability.']};
}
