import {evaluatePerformance} from './performance.mjs';

export const MIN_FORWARD_CLOSED_TRADES=30;
const entryActions=new Set(['buy','open-long','open-short']);
const settledStatuses=new Set(['submitted','reconciled']);
const knownStatuses=new Set(['pending','unknown','submitted','reconciled','rejected','hold']);
const tradeKey=value=>Number.isSafeInteger(value)&&value>0?String(value):
 typeof value==='string'&&/^[1-9]\d*$/.test(value)?value:null;
const validTag=value=>typeof value==='string'&&value.trim()===value&&value.length>0;
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const own=(object,key)=>Object.hasOwn(object,key);

function normalizeTrial(trial,asOf){
 if(!trial||typeof trial!=='object'||Array.isArray(trial)||!validTag(trial.version)||
  !validTime(trial.startedAt)||!validTime(asOf)||Date.parse(trial.startedAt)>Date.parse(asOf)||
  !['demo','demo-futures'].includes(trial.mode))throw new TypeError('FORWARD_TRIAL_INVALID_MARKER');
 const sets={};
 for(const name of ['strategyTags','probeTags']){
  const values=trial[name]??[];
  if(!Array.isArray(values)||values.some(value=>!validTag(value))||new Set(values).size!==values.length)
   throw new TypeError('FORWARD_TRIAL_INVALID_TAGS');
  sets[name]=new Set(values);
 }
 if([...sets.strategyTags].some(tag=>sets.probeTags.has(tag)))throw new TypeError('FORWARD_TRIAL_OVERLAPPING_TAGS');
 const excluded=trial.excludedTradeIds??[];
 if(!Array.isArray(excluded)||excluded.some(value=>tradeKey(value)===null))throw new TypeError('FORWARD_TRIAL_INVALID_EXCLUSIONS');
 return {...sets,excluded:new Set(excluded.map(tradeKey)),startedAt:Date.parse(trial.startedAt),asOf:Date.parse(asOf)};
}

// Only selected, non-sensitive evidence is returned. No raw API response or
// journal payload is spread into a report.
function tradeEvidence(trade){
 return {tradeId:trade.trade_id??null,pair:trade.pair??null,tag:trade.enter_tag??null,
  isOpen:typeof trade.is_open==='boolean'?trade.is_open:null,isShort:typeof trade.is_short==='boolean'?trade.is_short:null,
  openedAt:Number.isSafeInteger(trade.open_timestamp)&&Number.isFinite(new Date(trade.open_timestamp).getTime())?new Date(trade.open_timestamp).toISOString():null,
  closedAt:Number.isSafeInteger(trade.close_timestamp)&&Number.isFinite(new Date(trade.close_timestamp).getTime())?new Date(trade.close_timestamp).toISOString():null,
  orderIds:Array.isArray(trade.orders)?trade.orders.map(order=>order?.order_id??order?.id).filter(value=>
   typeof value==='string'||(typeof value==='number'&&Number.isFinite(value))).map(String):[]};
}

function journalState(journal,warnings,times){
 const latest=new Map();
 for(const [index,row] of journal.entries()){
  if(!row||typeof row!=='object'||Array.isArray(row)||!validTag(row.id)){
   warnings.push({code:'INVALID_JOURNAL_RECORD',index});continue;
  }
  // The append order is authoritative. Terminal journal rows intentionally
  // omit fields present in the earlier pending intent.
  const previous=latest.get(row.id)??{};
  const identityKeys=['tag','tradeId','pair','action'];
  for(const key of identityKeys){
   if(previous[key]!==undefined&&previous[key]!==null&&row[key]!==undefined&&row[key]!==null&&
    String(previous[key])!==String(row[key]))warnings.push({code:'JOURNAL_IDENTITY_CHANGED',id:row.id,field:key});
  }
  if(!validTime(row.at)||Date.parse(row.at)>times.asOf)warnings.push({code:'INVALID_JOURNAL_TIMESTAMP',id:row.id,index});
  if(!knownStatuses.has(row.status))warnings.push({code:'UNKNOWN_JOURNAL_STATUS',id:row.id,status:typeof row.status==='string'?row.status:null});
  latest.set(row.id,{...previous,...row});
 }
 return [...latest.values()];
}

function summary(trades,mode,asOf,scope,warnings){
 const evaluation=evaluatePerformance({trades,mode,observedAt:asOf});
 for(const diagnostic of evaluation.diagnostics)warnings.push({...diagnostic,scope});
 const stats=evaluation.summary;
 const observedOpen=trades.filter(trade=>trade.is_open===true),observedClosed=trades.filter(trade=>trade.is_open===false);
 return {openTrades:observedOpen.length,closedTrades:observedClosed.length,validClosedTrades:stats.closedTrades,
  invalidTrades:stats.invalidTrades,pnlComplete:stats.pnlComplete,netRealizedUsdt:stats.netRealizedUsdt,
  averageNetUsdt:stats.expectancyUsdt,winRate:stats.winRate,profitFactor:stats.profitFactor,
  profitFactorReason:stats.profitFactorReason,winningTrades:stats.pnlComplete?stats.winningTrades:null,
  losingTrades:stats.pnlComplete?stats.losingTrades:null,breakevenTrades:stats.pnlComplete?stats.breakevenTrades:null,
  openTradeIds:observedOpen.map(trade=>trade.trade_id),closedTradeIds:observedClosed.map(trade=>trade.trade_id),
  firstCloseAt:stats.firstCloseAt,lastCloseAt:stats.lastCloseAt,trades:trades.map(tradeEvidence)};
}

/**
 * Pure descriptive report over a complete live Demo engine history read.
 *
 * trial: { version, startedAt, mode: 'demo'|'demo-futures',
 *   strategyTags: string[], probeTags?: string[], excludedTradeIds?: (number|string)[],
 *   source: 'freqtrade-demo', historyComplete: true }
 *
 * strategyTags and probeTags are exact immutable entry-tag attribution supplied
 * by the caller from this version's entry records, never guessed from dates.
 * The caller must attest source/historyComplete only after checking the Demo
 * engine identity and reading BOTH all closed trades and current positions.
 * asOf is explicit, so this function has no clock, filesystem or network input.
 * Journal is the existing append-only orders.jsonl shape, already parsed.
 * This function does not submit, retry, reconcile or change any trading state.
 */
export function buildForwardTrialReport({trial,trades,journal=[],asOf}={}){
 const times=normalizeTrial(trial,asOf),warnings=[],ignored=[],groups={strategy:[],probes:[]};
 if(trial.source!=='freqtrade-demo')warnings.push({code:'DEMO_SOURCE_NOT_ATTESTED'});
 if(trial.historyComplete!==true)warnings.push({code:'HISTORY_NOT_CONFIRMED_COMPLETE'});
 if(!Array.isArray(trades))warnings.push({code:'INVALID_TRADES'});
 if(!Array.isArray(journal))warnings.push({code:'INVALID_JOURNAL'});
 const input=Array.isArray(trades)?trades:[],states=journalState(Array.isArray(journal)?journal:[],warnings,times);
 const seen=new Map();
 for(const trade of input){const key=tradeKey(trade?.trade_id);if(key)seen.set(key,(seen.get(key)??0)+1);}
 const scopeOf=tag=>times.probeTags.has(tag)?'probes':times.strategyTags.has(tag)?'strategy':null;
 for(const [index,trade] of input.entries()){
  if(!trade||typeof trade!=='object'||Array.isArray(trade)){
   warnings.push({code:'INVALID_TRADE',index});continue;
  }
  const key=tradeKey(trade.trade_id),scope=scopeOf(trade.enter_tag);
  const ignore=reason=>ignored.push({tradeId:trade.trade_id??null,reason});
  if(key&&times.excluded.has(key)){ignore('explicitly_excluded');continue;}
  if(Number.isSafeInteger(trade.open_timestamp)&&trade.open_timestamp<times.startedAt){ignore('opened_before_trial');continue;}
  if(!scope){
   ignore('unattributed_entry_tag');
   // A trade opened during the experiment but absent from the immutable tag
   // manifest may represent lost attribution. Do not quietly call the sample
   // complete until the caller either attributes or explicitly excludes it.
   if(!Number.isSafeInteger(trade.open_timestamp)||trade.open_timestamp>=times.startedAt)
    warnings.push({code:'UNATTRIBUTED_TRIAL_TRADE',tradeId:trade.trade_id??null,index});
   continue;
  }
  if((own(trade,'trial_version')&&trade.trial_version!==trial.version)||
   (own(trade,'strategyVersion')&&trade.strategyVersion!==trial.version)){
   ignore('version_mismatch');warnings.push({code:'TRADE_VERSION_MISMATCH',tradeId:trade.trade_id??null,scope});continue;
  }
  groups[scope].push(trade);
  if(key&&seen.get(key)!==1)warnings.push({code:'DUPLICATE_HISTORY_TRADE_ID',tradeId:trade.trade_id,scope});
  const matches=states.filter(row=>entryActions.has(row.action)&&row.tag===trade.enter_tag&&
   tradeKey(row.tradeId)===key&&row.pair===trade.pair);
  if(matches.length!==1||!settledStatuses.has(matches[0]?.status))
   warnings.push({code:matches.length>1?'AMBIGUOUS_ENTRY_JOURNAL':'ENTRY_SUBMISSION_NOT_CONFIRMED',tradeId:trade.trade_id??null,scope});
  if(trade.is_open===false&&(trade.has_open_orders===true||trade.orders?.some(order=>order?.is_open===true)))
   warnings.push({code:'CLOSED_TRADE_HAS_OPEN_ORDER',tradeId:trade.trade_id??null,scope});
 }
 const unresolved=[];
 for(const row of states){
  if(['pending','unknown'].includes(row.status)||!knownStatuses.has(row.status)){
   const item={id:row.id,status:row.status??null,action:row.action??null,tag:row.tag??null,
    tradeId:row.tradeId??null,pair:row.pair??null,scope:scopeOf(row.tag),at:row.at??null};
   unresolved.push(item);warnings.push({code:'UNRESOLVED_SUBMISSION',id:row.id,status:row.status??null,scope:item.scope});
  }
  if(!entryActions.has(row.action)||!scopeOf(row.tag)||!settledStatuses.has(row.status))continue;
  const matching=input.filter(trade=>trade?.enter_tag===row.tag&&tradeKey(trade.trade_id)===tradeKey(row.tradeId)&&trade.pair===row.pair);
  if(matching.length!==1)warnings.push({code:'SUBMITTED_TRADE_MISSING_OR_AMBIGUOUS',id:row.id,tradeId:row.tradeId??null,scope:scopeOf(row.tag)});
 }
 const strategy=summary(groups.strategy,trial.mode,asOf,'strategy',warnings),probes=summary(groups.probes,trial.mode,asOf,'probes',warnings);
 const evidenceComplete=warnings.length===0&&strategy.pnlComplete&&probes.pnlComplete;
 // Partial history must not look like complete realized account statistics.
 // Preserve useful broker-reported subset values under an explicitly partial key.
 if(trial.historyComplete!==true||trial.source!=='freqtrade-demo'||!Array.isArray(trades)){
  for(const group of [strategy,probes]){
   group.observedSubset={netRealizedUsdt:group.netRealizedUsdt,averageNetUsdt:group.averageNetUsdt,
    winRate:group.winRate,profitFactor:group.profitFactor};
   group.pnlComplete=false;group.netRealizedUsdt=null;group.averageNetUsdt=null;group.winRate=null;group.profitFactor=null;
   group.profitFactorReason='unattested_or_incomplete_history';
  }
 }
 const enough=evidenceComplete&&strategy.validClosedTrades>=MIN_FORWARD_CLOSED_TRADES;
 const status=!evidenceComplete?'incomplete_evidence':enough?'preliminary_sample_available':
  strategy.closedTrades===0?'awaiting_closed_trades':'collecting_sample';
 return {schemaVersion:1,source:'freqtrade-demo-forward-trial',asOf,mode:trial.mode,version:trial.version,startedAt:trial.startedAt,
  inputTrades:input.length,strategy,probes,ignored,journal:{intents:states.length,unresolvedSubmissions:unresolved},warnings,
  validation:{status,evidenceComplete,minValidClosedTrades:MIN_FORWARD_CLOSED_TRADES,
   validStrategyClosedTrades:strategy.validClosedTrades,remainingClosedTrades:Math.max(0,MIN_FORWARD_CLOSED_TRADES-strategy.validClosedTrades),
   preliminarySampleAvailable:enough,stableProfitabilityValidated:false,profitabilityValidationComplete:false,promotionAuthorized:false},
  limitations:[
   'Demo forward trades only. Backtests, old-version trades and connectivity probes are not strategy performance evidence.',
   'profit_abs is Freqtrade reported net accounting including its recorded fees and funding. Fees are not deducted again; original exchange commission reconciliation is outside this report.',
   'Open trade profit is not realized profit. Zero open positions does not mean zero completed trades.',
   'Thirty attributable closed strategy trades provide only a preliminary sample, even if net profit is positive. Stable profitability and live-money readiness are not established.',
   'Pending or unknown submissions require the existing explicit reconciliation flow. Finding a trade here never resolves or retries an order.'
  ]};
}
