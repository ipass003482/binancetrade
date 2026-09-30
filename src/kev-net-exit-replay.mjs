// Detached displayed-depth research. This module performs no I/O or trading.
import DecimalBase from 'decimal.js';
import {createHash} from 'node:crypto';
import {clockRange} from './exchange-clock.mjs';
import {QUOTE_PATH_ARCHIVE_VERSION,quotePathDigest} from './quote-path-archive.mjs';
import {auditTradePath,depthExitQuote} from '../scripts/kev-executable-path-audit.mjs';

const D=DecimalBase.clone({precision:40});
const SOURCES={demo:'https://demo-api.binance.com','demo-futures':'https://demo-fapi.binance.com'};
const ts=v=>Number.isSafeInteger(v)&&v>0;
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const num=v=>{if(!['number','string'].includes(typeof v)||String(v).length>100)throw Error('NUMBER_INVALID');const d=new D(v);if(!d.isFinite()||(!d.isZero()&&Math.abs(d.e)>50))throw Error('NUMBER_INVALID');return d;};
const sha=s=>createHash('sha256').update(s).digest('hex');
export const NET_EXIT_REPLAY_VERSION='kev-net-exit-displayed-depth-v1';
export const FROZEN_EXIT_POLICIES=Object.freeze({
 baseline:{stopFraction:'.005',targetFraction:'.015',maxHoldingSeconds:900,trailTriggerNetUsdt:'.50',trailGivebackNetUsdt:'.25'},
 staged:{stopFraction:'.005',before300TargetFraction:'.015',from300To599TargetNetUsdt:'1',from600To899TargetNetBps:'10',maxHoldingSeconds:900,
  trailTriggerNetUsdt:'.50',trailGivebackNetUsdt:'.25',riskBudgetUsdt:'1'}
});
// Separate prospective additive exit hypothesis. It never replaces or raises
// the existing gross target; the original staged study remains unchanged.
export const NET_HARVEST_REPLAY_VERSION='kev-net-harvest-displayed-depth-v1';
export const FROZEN_NET_HARVEST_POLICIES=Object.freeze({
 baseline:FROZEN_EXIT_POLICIES.baseline,
 net_harvest:Object.freeze({version:'kev-net-harvest-v1',stopFraction:'.005',alwaysTargetFraction:'.015',
  from300To599AdditionalNetUsdt:'1',from600To899AdditionalNetBps:'10',maxHoldingSeconds:900,
  trailTriggerNetUsdt:'.50',trailGivebackNetUsdt:'.25',riskBudgetUsdt:'1',
  exitSlippageBps:'5',
  targetComposition:'original_gross_target_OR_age_eligible_net_target'})
});

// Checksums bind supplied retained bytes, not independent exchange authenticity.
export function decodeKevQuoteArchive({mode,pair,archiveFiles=[],asOf}={}){
 if(!SOURCES[mode]||!ts(asOf)||!Array.isArray(archiveFiles))throw Error('REPLAY_ARCHIVE_ARGS_INVALID');
 const snapshots=[],issues=[],inputs=[],seen=new Set();let bytes=0;
 for(const f of archiveFiles){
  if(typeof f?.name!=='string'||typeof f.text!=='string'){issues.push({reason:'ARCHIVE_FILE_INVALID'});continue;}
  bytes+=Buffer.byteLength(f.text);inputs.push({name:f.name,sha256:sha(f.text),bytes:Buffer.byteLength(f.text)});
  if(bytes>512*1024*1024){issues.push({file:f.name,reason:'ARCHIVE_READ_BUDGET_EXCEEDED'});break;}
  if(f.text.length&&!f.text.endsWith('\n'))issues.push({file:f.name,reason:'ARCHIVE_TORN_TAIL'});
  for(const [index,line] of f.text.split(/\r?\n/).entries()){
   if(!line.trim())continue;let range=null;
   try{
    if(Buffer.byteLength(line)>256*1024)throw Error('ARCHIVE_RECORD_TOO_LARGE');
    const r=JSON.parse(line),{recordId,...body}=r;
    if(!hex(recordId)||quotePathDigest(body)!==recordId)throw Error('ARCHIVE_CHECKSUM_INVALID');
    if(r.version!==QUOTE_PATH_ARCHIVE_VERSION||r.hashEncoding!=='sha256-canonical-json-excluding-recordId'||r.mode!==mode||r.usedForEntries!==false
     ||!ts(r.observedAt)||!ts(r.completedAt)||r.completedAt<r.observedAt||!Array.isArray(r.observations)||!Array.isArray(r.missingPairs))throw Error('ARCHIVE_ENVELOPE_INVALID');
    if(r.observations.every(o=>o?.book===null||ts(o?.book?.at)&&o.book.at>=r.observedAt&&o.book.at<=r.completedAt))range={from:r.observedAt,to:r.completedAt};
    if(r.completedAt>asOf)continue;
    if(seen.has(recordId))continue;seen.add(recordId);
    const pattern=mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/;
    if(r.missingPairs.some(o=>!pattern.test(o?.pair??'')||typeof o.reason!=='string'||!o.reason.length)
     ||new Set([...r.observations,...r.missingPairs].map(o=>o.pair)).size!==r.observations.length+r.missingPairs.length)throw Error('ARCHIVE_PAIR_IDENTITY_INVALID');
    if(r.clock===null){
     if(r.observations.length||!r.missingPairs.length)throw Error('ARCHIVE_UNAVAILABLE_ENVELOPE_INVALID');
    }else{
     if(r.clock?.receivedAt!==r.observedAt)throw Error('ARCHIVE_CLOCK_ENVELOPE_INVALID');
     clockRange(r.clock,mode,r.completedAt);
    }
    if(r.missingPairs.some(o=>o.pair===pair))issues.push({file:f.name,line:index+1,reason:'PAIR_OBSERVATION_UNAVAILABLE',range});
    const telemetry=r.telemetry??{};
    if(telemetry.droppedSince!==null&&telemetry.droppedSince!==undefined){
     if(!ts(telemetry.droppedSince)||!ts(telemetry.lastDroppedAt)||telemetry.lastDroppedAt<telemetry.droppedSince)throw Error('ARCHIVE_DROP_TELEMETRY_INVALID');
     issues.push({file:f.name,line:index+1,reason:'ARCHIVE_DROPPED_OBSERVATIONS',range:{from:telemetry.droppedSince,to:telemetry.lastDroppedAt}});
    }
    for(const o of r.observations){
     if(!pattern.test(o.pair??'')||o.source!==SOURCES[mode]||!hex(o.rawProofSha256)||o.rawProofHashEncoding!=='sha256-canonical-json'||o.rawProofRetained!==false)throw Error('ARCHIVE_OBSERVATION_INVALID');
     if(o.pair!==pair)continue;
     if(o.dataStatus!=='ok'||!o.book){issues.push({file:f.name,line:index+1,reason:'PAIR_DEPTH_UNAVAILABLE',range});continue;}
     const b=o.book;
     if(!ts(b.at)||!ts(b.requestAt)||b.requestAt<r.clock.receivedAt||b.requestAt>b.at||b.at>r.completedAt||b.at-b.requestAt>1500
      ||!Number.isSafeInteger(b.updateId)||b.updateId<0||b.bids?.length!==5||b.asks?.length!==5||depthExitQuote(b,'0.000000000001',false).status==='invalid_depth')throw Error('ARCHIVE_DEPTH_OR_TIME_INVALID');
     snapshots.push({sha256:recordId,snapshot:{id:recordId,mode,clock:r.clock,markets:[{mode,pair,source:SOURCES[mode],
      verifiedSpot:mode==='demo',verifiedFutures:mode==='demo-futures',orderFlow:{mode,pair,source:SOURCES[mode],books:[b]}}]}});
    }
   }catch(e){issues.push({file:f.name,line:index+1,reason:/^(ARCHIVE_|CLOCK_)/.test(e.message)?e.message:'ARCHIVE_RECORD_INVALID',...(range?{range}:{})});}
  }
 }
 if(!archiveFiles.length)issues.push({reason:'ARCHIVE_FILES_UNAVAILABLE'});
 return {snapshots,issues,inputs,bytes,checksumScope:'Retained envelope/depth only; original tape proof is not independently reconstructible.'};
}

function fundingReader({mode,trade,evidence,asOf,entryAt}){
 if(mode==='demo')return ()=>({status:'known',net:new D(0),basis:'not_applicable'});
 try{
  const {recordId,...body}=evidence??{};
  if(!hex(recordId)||quotePathDigest(body)!==recordId||body.version!=='kev-funding-event-ledger-v1'||body.mode!==mode||body.pair!==trade.pair
   ||body.tradeId!==trade.trade_id||body.source!==SOURCES[mode]||body.basis!=='trade_cashflows'||body.complete!==true
   ||!num(body.quantity).eq(trade.amount)||!ts(body.coverageFrom)||!ts(body.coverageThrough)||body.coverageFrom>entryAt||body.coverageThrough<body.coverageFrom
   ||!ts(body.observedAt)||body.observedAt>asOf||body.observedAt<body.coverageThrough||!Array.isArray(body.events))throw Error();
  const ids=new Set(),events=body.events.map(e=>{
   if(typeof e.id!=='string'||!e.id||ids.has(e.id)||!ts(e.at)||!ts(e.knownAt)||e.knownAt<e.at||e.knownAt>body.observedAt
    ||e.at<entryAt||e.at<body.coverageFrom||e.at>body.coverageThrough)throw Error();
   ids.add(e.id);return {...e,net:num(e.netUsdt)};
  });
  return at=>{
   if(at<body.coverageFrom||at>body.coverageThrough||(trade.is_open===false&&at>trade.close_timestamp))return {status:'unavailable',reason:'FUNDING_COVERAGE_UNAVAILABLE'};
   const applicable=events.filter(e=>e.at<=at);
   if(applicable.some(e=>e.knownAt>at))return {status:'unavailable',reason:'FUNDING_NOT_KNOWN_AT_QUOTE'};
   return {status:'known',net:applicable.reduce((s,e)=>s.plus(e.net),new D(0)),basis:'timestamped_signed_trade_funding_events'};
  };
 }catch{return ()=>({status:'unavailable',reason:'POINT_IN_TIME_FUNDING_EVIDENCE_UNAVAILABLE'});}
}

function tickFor(trade){
 if(trade.precision_mode_price===4){const tick=num(trade.price_precision);if(tick.lte(0))throw Error('PRICE_PRECISION_INVALID');return tick;}
 if(trade.precision_mode_price===2&&Number.isSafeInteger(trade.price_precision)&&trade.price_precision>=0&&trade.price_precision<=18)return new D(10).pow(-trade.price_precision);
 throw Error('PRICE_PRECISION_INVALID');
}
function netAt({trade,quote,funding,slippage}){
 const sign=trade.is_short?1:-1,gross=num(quote.grossQuote).mul(new D(1).plus(slippage.mul(sign))),fee=gross.mul(num(trade.fee_close)),open=num(trade.open_trade_value);
 const netBeforeFunding=trade.is_short?open.minus(gross.plus(fee)):gross.minus(fee).minus(open);
 return {gross,exitFee:fee,netBeforeFunding,net:netBeforeFunding.plus(funding),price:gross.div(trade.amount)};
}

function replayPolicy({policy,trade,entryAt,samples,issues,readFunding,slippage,maxGapMs,tick}){
 const open=num(trade.open_rate),qty=num(trade.amount),initialStop=open.mul(trade.is_short?'1.005':'.995'),entryNotional=qty.mul(open);
 let priorAt=entryAt,peak=null,trailStop=null,pending=null,checked=0;
 const unavailable=(reason,at=null)=>({policy,status:'unavailable',reason,at,checkedDepthSamples:checked,exit:null,pendingTrigger:pending});
 for(const sample of samples){
  const at=Date.parse(sample.at);if(at<entryAt)continue;
  const relevant=issues.filter(e=>!e.range||e.range.to>=entryAt&&e.range.from<=at);
  if(relevant.length)return {...unavailable('ARCHIVE_EVIDENCE_INCOMPLETE',at),issues:relevant.slice(0,20)};
  if(at-priorAt>maxGapMs)return {...unavailable('QUOTE_PATH_GAP',at),gap:{from:priorAt,to:at,gapMs:at-priorAt}};
  if(sample.quote.status!=='observed_depth_scenario'||!['quote_only_net_scenario','quote_only_funding_unknown'].includes(sample.feeScenario.status))
   return unavailable(sample.quote.status==='observed_depth_scenario'?sample.feeScenario.status:sample.quote.status,at);
  const funding=readFunding(at);if(funding.status!=='known')return unavailable(funding.reason,at);
  const current=netAt({trade,quote:sample.quote,funding:funding.net,slippage:new D(0)});checked++;
  if(pending&&at>pending.at){
   const execution=netAt({trade,quote:sample.quote,funding:funding.net,slippage});
   return {policy,status:'indicative_displayed_depth_simulation',checkedDepthSamples:checked,
    signal:pending,exit:{at,latencyMs:at-pending.at,reason:pending.reason,quantity:qty.toFixed(),side:trade.is_short?'buy':'sell',
     displayedVwap:sample.quote.vwap,scenarioExitPrice:execution.price.toFixed(),levelsUsed:sample.quote.levelsUsed,
     grossExitUsdt:execution.gross.toFixed(),exitFeeUsdt:execution.exitFee.toFixed(),signedFundingUsdt:funding.net.toFixed(),
     netBeforeFundingUsdt:execution.netBeforeFunding.toFixed(),netUsdt:execution.net.toFixed(),
     counterfactualExposureAfterActualClose:trade.is_open===false&&at>trade.close_timestamp,recordSha256:sample.snapshotSha256},
    peakObservedNetUsdt:peak?.toFixed()??null,persistedTrailStopPrice:trailStop?.toFixed()??null};
  }
  // Match RuleExits monetary high-water mark and never loosen a persisted stop.
  if(peak!==null||current.net.gte('.50')){
   peak=peak===null?current.net:D.max(peak,current.net);const protectedNet=peak.minus('.25');
   const slope=qty.mul(trade.is_short?new D(1).plus(trade.fee_close):new D(1).minus(trade.fee_close));
   const solved=trade.is_short?num(trade.open_trade_value).plus(funding.net).minus(protectedNet).div(slope):num(trade.open_trade_value).minus(funding.net).plus(protectedNet).div(slope);
   const rounded=solved.div(tick).toDecimalPlaces(0,trade.is_short?D.ROUND_DOWN:D.ROUND_UP).mul(tick);
   if(rounded.lte(0))return unavailable('TRAIL_PRICE_INVALID',at);
   trailStop=trade.is_short?D.min(trailStop??initialStop,rounded):D.max(trailStop??initialStop,rounded);
  }
  const ageMs=at-trade.open_timestamp,change=current.price.div(open).minus(1).mul(trade.is_short?-1:1);
  let reason=null,targetNet=null,thresholdNet=null;
  if(trailStop&&(trade.is_short?current.price.gte(trailStop):current.price.lte(trailStop)))reason='rules_profit_trail';
  else if(change.lte('-.005'))reason='rules_stop';
  else if(policy==='baseline'){
   if(change.gte('.015'))reason='rules_target';else if(ageMs>=900000)reason='rules_time';
  }else if(policy==='net_harvest'){
   // Keep every baseline trigger and its precedence. Additional net targets
   // apply only before the unchanged cap, with no hindsight-fitted threshold.
   if(change.gte('.015'))reason='rules_target';
   else if(ageMs>=900000)reason='rules_time';
   else if(ageMs>=300000){
    targetNet=ageMs<600000?new D(1):entryNotional.mul('.001');
    // The frozen signal reserve is independent of the execution stress arm.
    // Only a hypothetical exit is slipped; the actual filled entry is intact.
    thresholdNet=netAt({trade,quote:sample.quote,funding:funding.net,slippage:new D('.0005')}).net;
    if(thresholdNet.gte(targetNet))reason=ageMs<600000?'net_harvest_1usdt':'net_harvest_10bps';
   }
  }else if(ageMs>=900000)reason='rules_time';
  else if(ageMs<300000){if(change.gte('.015'))reason='rules_target';}
  else{
   targetNet=ageMs<600000?new D(1):entryNotional.mul('.001');
   if(current.net.gte(targetNet))reason=ageMs<600000?'staged_net_1usdt':'staged_net_10bps';
  }
  if(reason)pending={at,reason,ageMs,displayedVwap:sample.quote.vwap,netUsdt:current.net.toFixed(),
   signedFundingUsdt:funding.net.toFixed(),targetNetUsdt:targetNet?.toFixed()??null,recordSha256:sample.snapshotSha256,
   ...(thresholdNet===null?{}:{thresholdNetUsdt:thresholdNet.toFixed(),thresholdExitSlippageBps:'5'})};
  priorAt=at;
 }
 return unavailable(pending?'NEXT_OBSERVATION_UNAVAILABLE':'TIME_CAP_PATH_UNCOVERED');
}

function comparePolicyReplay({mode,trade,archiveFiles=[],observedAt,fundingEvidence=null,adverseSlippageBps='0',maxGapMs=20000}={},variant='staged'){
 const asOf=typeof observedAt==='string'?Date.parse(observedAt):NaN;
 if(!SOURCES[mode]||!ts(asOf)||!Number.isSafeInteger(maxGapMs)||maxGapMs<1||maxGapMs>20000)throw Error('NET_EXIT_REPLAY_ARGS_INVALID');
 const harvest=variant==='net_harvest';
 const result={version:harvest?NET_HARVEST_REPLAY_VERSION:NET_EXIT_REPLAY_VERSION,mode,tradeId:trade?.trade_id??null,pair:trade?.pair??null,observedAt,
  readOnly:true,actualTradeWinRate:null,automaticPromotion:false,approvedEntryMembershipVerified:false,
  policies:harvest?FROZEN_NET_HARVEST_POLICIES:FROZEN_EXIT_POLICIES,
  status:'unavailable',comparison:null,results:[],limitations:[
   'Indicative sampled displayed-depth simulation, not orders, fills, realized PnL or actual win rate. Intra-sample native stop/target events are unknown.',
   'Signals consume full-quantity exit-side depth; execution uses the next distinct observation plus adverse slippage. This differs from native quote/callback timing.',
   'Actual entry identity and engine fee basis are checked; caller must independently verify original Kev approval and goal membership.',
   'Retained checksums do not independently authenticate missing raw tape or caller-supplied funding source. Final cumulative funding cannot reconstruct earlier decisions.',
   harvest?'Additive net-harvest thresholds are a separate frozen prospective hypothesis, not fitted forecasts; original gross target remains active.':
    'Staged thresholds are frozen hypotheses, not fitted forecasts; no automatic native policy promotion.'
  ]};
 try{
  const slip=num(adverseSlippageBps);if(slip.lt(0)||slip.gt(100))throw Error('SLIPPAGE_INVALID');
  if(!trade||typeof trade.is_short!=='boolean'||mode==='demo'&&trade.is_short||!ts(trade.open_timestamp)
   ||(trade.is_open===false&&!ts(trade.close_timestamp)))throw Error('TRADE_IDENTITY_INVALID');
  // The first sampled cap trigger can be one permitted observation gap after
  // 900s; its delayed execution needs one further permitted observation gap.
  // This is an archive coverage allowance, never an actual order latency bound.
  const tick=tickFor(trade),requestedThrough=trade.open_timestamp+900000+2*maxGapMs,end=Math.min(asOf,requestedThrough);
  result.sampleWindow={capAt:trade.open_timestamp+900000,requestedThrough,effectiveThrough:end,maxObservationGapMs:maxGapMs,
   basis:'first_observed_cap_trigger_plus_next_observation_not_live_latency_bound'};
  const archive=decodeKevQuoteArchive({mode,pair:trade.pair,archiveFiles,asOf});result.archive={inputs:archive.inputs,issues:archive.issues,checksumScope:archive.checksumScope};
  const audit=auditTradePath({mode,trade:{...trade,is_open:true},snapshots:archive.snapshots,observedAt:new Date(end).toISOString(),maxGapMs});
  result.entry=audit.entry;result.adverseSlippageBps=slip.toFixed();result.entryAccountingBasis='verified_engine_open_trade_value_including_open_fee';
  if(audit.entry.status!=='verified_entry_fill')throw Error(audit.entry.status);
  const readFunding=fundingReader({mode,trade,evidence:fundingEvidence,asOf,entryAt:audit.entry.at});
  result.results=['baseline',variant].map(policy=>replayPolicy({policy,trade,entryAt:audit.entry.at,samples:audit.samples,
   issues:archive.issues,readFunding,slippage:slip.div(10000),maxGapMs,tick}));
  if(result.results.every(r=>r.status==='indicative_displayed_depth_simulation')){
   result.status='indicative_comparison';result.comparison={
    [harvest?'harvestMinusBaselineNetUsdt':'stagedMinusBaselineNetUsdt']:num(result.results[1].exit.netUsdt).minus(result.results[0].exit.netUsdt).toFixed(),
    interpretation:'Single matched-entry quote-path difference only; not evidence of improved live win rate or profitability.'};
  }else result.status='incomplete_evidence';
 }catch(e){result.reason=e.message;}
 return result;
}

export function compareKevNetExitReplay(options={}){return comparePolicyReplay(options,'staged');}
export function compareKevNetHarvestReplay(options={}){return comparePolicyReplay(options,'net_harvest');}
