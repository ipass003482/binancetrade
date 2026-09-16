// Prospective initial-rule candidates only. No orders, account reads or gates.
import {createHash} from 'node:crypto';
import DecimalBase from 'decimal.js';
const D=DecimalBase.clone({precision:40,rounding:DecimalBase.ROUND_HALF_EVEN});
const CostProducerDecimal=DecimalBase.clone({precision:20,rounding:DecimalBase.ROUND_HALF_UP});
export const CANDIDATE_VERSION='spot-initial-candidate-v1';
export const CANDIDATE_HORIZONS=Object.freeze([60000,300000,900000]);
export const CANDIDATE_LATENESS_MS=20000;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stamp=v=>typeof v==='string'?Date.parse(v):NaN;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const number=v=>{if(!['string','number'].includes(typeof v)||String(v).length>128)throw Error();const d=new D(v);if(!d.isFinite()||(!d.isZero()&&Math.abs(d.e)>50))throw Error();return d;};
const positive=v=>{const d=number(v);if(d.lte(0))throw Error();return d;};
const triAnd=values=>values.includes(false)?false:values.every(v=>v===true)?true:null;

function costs(cost,pair,now){
 try{
  if(cost?.status!=='ok'||cost.mode!=='demo'||cost.pair!==pair||cost.source!=='https://demo-api.binance.com'||!Number.isFinite(stamp(cost.observedAt))||stamp(cost.observedAt)>now||now-stamp(cost.observedAt)>900000)return null;
  const buy=number(cost.buyRate),sell=number(cost.sellRate),slip=number(cost.slippageBpsPerSide),fees=number(cost.roundTripFeeBps),spread=number(cost.spreadBps);
  const producerTotal=new CostProducerDecimal(fees.toFixed()).plus(spread.toFixed()).plus(slip.mul(2).toFixed());
  if(buy.lt(0)||buy.gt('.1')||sell.lt(0)||sell.gt('.1')||slip.lt(0)||slip.gt(100)||spread.lt(0)||!fees.eq(buy.plus(sell).mul(10000))||!number(cost.fundingReserveBps).eq(0)||!number(cost.estimatedRoundTripCostBps).eq(producerTotal.toFixed()))return null;
  return {source:cost.source,observedAt:cost.observedAt,method:cost.method??null,buyRate:buy.toFixed(),sellRate:sell.toFixed(),roundTripFeeBps:fees.toFixed(),slippageBpsPerSide:slip.toFixed(),spreadBps:spread.toFixed(),additionalCostBps:fees.plus(slip.mul(2)).toFixed(),fundingReserveBps:'0',basis:'recorded_undiscounted_fees_plus_two_side_slippage_no_spread'};
 }catch{return null;}
}

export function makeInitialSpotCandidates({snapshot,reference,policy,account,strategyVersion,now=Date.now()}={}){
 if(policy?.mode!=='demo'||snapshot?.mode!=='demo'||!integer(now)||!Array.isArray(snapshot.markets)||!Array.isArray(reference?.candidates)||reference.metadata?.snapshotId!==snapshot.id||!Array.isArray(account?.trades))return [];
 const snapshotHash=hash(snapshot),rulesHash=hash(reference),seen=new Set(),result=[];
 const used=account.trades.reduce((sum,t)=>sum+Number(t.stake_amount),0),limit=Number(policy.maxExposureUsdt),slots=policy.maxOpenTrades;
 for(const candidate of reference.candidates){
  const pair=candidate.pair,matches=snapshot.markets.filter(m=>m.pair===pair);
  if(!/^[A-Z0-9]+\/USDT$/.test(pair??'')||seen.has(pair)||matches.length!==1)continue;seen.add(pair);
  const market=matches[0],check=candidate.directionChecks?.find(c=>c.action==='buy'),reasons=candidate.reasons??[];
  const cost=costs(market.entryCost,pair,now),at=stamp(market.fetchedAt);let quote=null;
  try{if(integer(at)&&at<=now&&now-at<=15000&&positive(market.bid).lt(positive(market.ask)))quote={at,bid:positive(market.bid).toFixed(),ask:positive(market.ask).toFixed(),basis:'initial_snapshot_market_quote'};}catch{}
  const ruleCostRisk=check?.eligible===true?true:reasons.some(r=>['BASELINE_PRICE_SPACE_TOO_SMALL','FLOW_NET_REWARD_RISK_TOO_SMALL'].includes(r))?false:null;
  const size=candidate.sizing?.eligible===false?false:candidate.action==='buy'&&Number(candidate.stakeUsdt)>0?true:null;
  const heldAllowed=!account.trades.some(t=>t.pair===pair);
  const capacity=Number.isFinite(used)&&used>=0&&Number.isFinite(limit)&&limit>=0&&Number.isSafeInteger(slots)&&slots>=0&&size===true?
   account.trades.length<slots&&used+Number(candidate.stakeUsdt)<=limit:null;
  const qualifications={baseFlow:typeof check?.flowDiagnostics?.eligible==='boolean'?check.flowDiagnostics.eligible:null,
   priceContinuation:typeof check?.executionContinuation?.eligible==='boolean'?check.executionContinuation.eligible:null,
   costEvidenceKnown:cost!==null,costRisk:ruleCostRisk,size,heldPairAllowed:heldAllowed,capacity,selected:reference.selected?.pair===pair,
   initialOrderCandidate:triAnd([ruleCostRisk,size,heldAllowed,capacity]),
   bridgeExecutionQuote:null,bridgeQuality:null,nativeProtection:null,sharedPortfolio:null,submitted:null,filled:null};
  const candidateId=hash([CANDIDATE_VERSION,snapshot.id,pair,'initial_candidate']);
  result.push({version:CANDIDATE_VERSION,kind:'initialSpotCandidate',recordId:'candidate:'+candidateId,candidateId,mode:'demo',phase:'initial_candidate',pair,
   createdAt:now,snapshotId:snapshot.id,policy:candidate.entryPolicyVersion??null,executionQualityVersion:candidate.executionQualityVersion??null,
   strategyFingerprint:strategyVersion?.fingerprint??null,quote,cost,qualifications,requestedStakeUsdt:candidate.stakeUsdt??null,
   capacityEvidence:{usedExposureUsdt:Number.isFinite(used)?String(used):null,maxExposureUsdt:Number.isFinite(limit)?String(limit):null,openTradeCount:account.trades.length,maxOpenTrades:Number.isSafeInteger(slots)?slots:null},
   reasons:[...reasons],sizingReasons:candidate.sizing?.reasons??[],
   evidence:{snapshotPath:'runs/'+snapshot.id+'.snapshot.json',rulesPath:'runs/'+snapshot.id+'.rules.json',snapshotJsonSha256:snapshotHash,rulesJsonSha256:rulesHash,
    flowProofSha256:market.orderFlow?hash(market.orderFlow):null},
   note:'Initial rule/account snapshot only; bridge and actual fill qualification unknown. Prospective quote study, not PnL.'});
 }
 return result;
}

// Future quotes do not need a bullish signal: requiring one would censor losers.
export function freshSpotCandidateQuotes(sample,now){
 if(sample?.mode!=='demo'||!integer(now))return [];
 const out=[];
 for(const [pair,p]of Object.entries(sample.markets??{}))try{
  if(p?.mode!=='demo'||p.pair!==pair||p.source!=='https://demo-api.binance.com'||!/^([A-Z0-9]+)\/USDT$/.test(pair))continue;
  const b=p.books?.at(-1);if(!integer(b?.at)||b.at>now||now-b.at>20000||!integer(b.updateId))continue;
  for(const [name,long]of [['bids',true],['asks',false]]){
   if(!Array.isArray(b[name])||b[name].length!==5)throw Error();
   for(let i=0;i<5;i++){const row=b[name][i];if(!Array.isArray(row)||row.length!==2)throw Error();positive(row[1]);const price=positive(row[0]);if(i&&(long?price.gte(b[name][i-1][0]):price.lte(b[name][i-1][0])))throw Error();}
  }
  const bid=positive(b.bids[0][0]),ask=positive(b.asks[0][0]);if(bid.gte(ask))continue;
  out.push({pair,at:b.at,observedAt:now,bid:bid.toFixed(),ask:ask.toFixed(),quoteSha256:hash({pair,source:p.source,book:b})});
 }catch{}
 return out;
}

export function newSpotCandidateState(now){return {version:CANDIDATE_VERSION,lastNow:now,pending:[],seen:{},nonOverlap:{}};}
function candidateValid(c,now){try{return c?.version===CANDIDATE_VERSION&&c.kind==='initialSpotCandidate'&&c.phase==='initial_candidate'&&c.mode==='demo'
 &&/^[a-f0-9]{64}$/.test(c.candidateId)&&c.recordId==='candidate:'+c.candidateId&&c.candidateId===hash([CANDIDATE_VERSION,c.snapshotId,c.pair,c.phase])
 &&/^[A-Z0-9]+\/USDT$/.test(c.pair)&&integer(c.createdAt)&&c.createdAt<=now&&c.qualifications&&c.evidence
 &&(c.quote===null||(integer(c.quote.at)&&c.quote.at<=c.createdAt&&c.createdAt-c.quote.at<=15000&&positive(c.quote.bid).lt(positive(c.quote.ask))))
 &&(c.cost===null||(number(c.cost.additionalCostBps).gte(0)&&number(c.cost.additionalCostBps).eq(number(c.cost.roundTripFeeBps).plus(number(c.cost.slippageBpsPerSide).mul(2)))));}catch{return false;}}

const quoteValid=q=>{try{return integer(q?.at)&&integer(q.observedAt)&&q.at<=q.observedAt&&q.observedAt-q.at<=20000&&positive(q.bid).lt(positive(q.ask))&&/^[a-f0-9]{64}$/.test(q.quoteSha256);}catch{return false;}};
const identity=(r,c)=>r.version===CANDIDATE_VERSION&&r.candidateId===c.candidateId&&r.pair===c.pair&&r.mode===c.mode&&r.phase===c.phase&&r.policy===c.policy&&r.executionQualityVersion===c.executionQualityVersion;
const metadata=c=>({version:CANDIDATE_VERSION,candidateId:c.candidateId,pair:c.pair,mode:c.mode,phase:c.phase,policy:c.policy,executionQualityVersion:c.executionQualityVersion});
function anchorValid(a,c){return a?.kind==='candidateQuoteAnchor'&&a.recordId==='candidate-anchor:'+c.candidateId&&identity(a,c)&&quoteValid(a.quote)&&a.quote.pair===c.pair&&a.quote.at>=c.createdAt&&a.quote.observedAt<=c.createdAt+20000&&integer(a.recordedAt)&&a.recordedAt>=a.quote.observedAt;}
function pendingFor(c){return CANDIDATE_HORIZONS.map(horizonMs=>({candidate:structuredClone(c),horizonMs,anchor:null,nonOverlap:null}));}

export function advanceSpotCandidates(state,{now,candidates=[],quotes=[]}={}){
 if(state?.version!==CANDIDATE_VERSION||!integer(now)||!integer(state.lastNow)||now<state.lastNow||!Array.isArray(state.pending)||state.pending.length>1024||!state.seen||!state.nonOverlap)throw Error('CANDIDATE_STATE_INVALID');
 const next=structuredClone(state),records=[],diagnostics={accepted:0,duplicates:0,invalid:0,capacitySkipped:0};
 for(const c of candidates){
  if(!candidateValid(c,now)){diagnostics.invalid++;continue;}
  const digest=hash(c),prior=next.seen[c.candidateId];if(prior){if(prior.hash!==digest)throw Error('CANDIDATE_CONFLICT');diagnostics.duplicates++;continue;}
  if(c.createdAt<state.lastNow){diagnostics.invalid++;continue;}
  if(next.pending.length+3>1024){diagnostics.capacitySkipped++;continue;}
  next.seen[c.candidateId]={at:c.createdAt,hash:digest};records.push({...structuredClone(c),recordedAt:now});diagnostics.accepted++;
  next.pending.push(...pendingFor(c));
 }
 const left=[],anchors=new Map();
 for(const p of next.pending){
  const c=p.candidate;if(!candidateValid(c,now)||!CANDIDATE_HORIZONS.includes(p.horizonMs)||(p.anchor===null?p.nonOverlap!==null:!anchorValid(p.anchor,c)||typeof p.nonOverlap!=='boolean'))throw Error('CANDIDATE_PENDING_INVALID');
  if(p.anchor===null){
   let anchor=anchors.get(c.candidateId);
   if(!anchor){const quote=quotes.filter(q=>quoteValid(q)&&q.pair===c.pair&&q.at>=c.createdAt&&q.observedAt<=now&&q.observedAt>=state.lastNow&&q.observedAt<=c.createdAt+20000).sort((a,b)=>a.observedAt-b.observedAt||a.at-b.at)[0];
    if(quote){anchor={...metadata(c),kind:'candidateQuoteAnchor',recordId:'candidate-anchor:'+c.candidateId,quote:structuredClone(quote),recordedAt:now,basis:'first_observed_after_initial_candidate'};anchors.set(c.candidateId,anchor);records.push(anchor);}}
   if(anchor){p.anchor=anchor;const key=JSON.stringify([c.policy,c.executionQualityVersion,c.pair,p.horizonMs]),last=next.nonOverlap[key];p.nonOverlap=last===undefined||anchor.quote.at-last>=p.horizonMs;if(p.nonOverlap)next.nonOverlap[key]=anchor.quote.at;}
   else if(now<=c.createdAt+20000){left.push(p);continue;}
  }
  const target=p.anchor?p.anchor.quote.at+p.horizonMs:null;
  const q=target===null?null:quotes.filter(q=>quoteValid(q)&&q.pair===c.pair&&q.at>=target&&q.observedAt<=now&&q.observedAt<=target+CANDIDATE_LATENESS_MS&&q.observedAt>=state.lastNow)
   .sort((a,b)=>a.observedAt-b.observedAt||a.at-b.at)[0];
  if(target!==null&&!q&&now<=target+CANDIDATE_LATENESS_MS){left.push(p);continue;}
  const raw=q?positive(q.bid).div(p.anchor.quote.ask).minus(1).mul(10000):null;
  records.push({version:CANDIDATE_VERSION,kind:'hypotheticalCandidateQuoteMarkout',recordId:`candidate-markout:${c.candidateId}:${p.horizonMs}`,candidateId:c.candidateId,pair:c.pair,
   mode:'demo',phase:c.phase,policy:c.policy,executionQualityVersion:c.executionQualityVersion,qualifications:structuredClone(c.qualifications),anchorAt:p.anchor?.quote.at??null,anchorAsk:p.anchor?.quote.ask??null,
   horizonMs:p.horizonMs,targetAt:target,nonOverlap:p.nonOverlap,status:target===null?'unavailable':q?'observed':'missing',reason:target===null?'NO_POST_DECISION_ANCHOR_QUOTE':q?null:'NO_FRESH_QUOTE_WITHIN_20S',
   futureQuote:q??null,recordedAt:now,rawQuoteMarkoutBps:raw?.toFixed()??null,additionalCostBps:c.cost?.additionalCostBps??null,
   estimatedAfterAdditionalCostBps:raw&&c.cost?raw.minus(c.cost.additionalCostBps).toFixed():null,
   note:'Ask-to-future-bid already includes spread. Additional cost uses recorded fees and two-side slippage estimate; not actual fills, win rate or PnL.'});
 }
 next.pending=left;next.lastNow=now;
 for(const [id,value]of Object.entries(next.seen))if(now-value.at>1800000&&!left.some(p=>p.candidate.candidateId===id))delete next.seen[id];
 return {state:next,records,diagnostics};
}

function nonOverlapEvidence(byId){
 const flags=new Map(),lasts={};
 for(const a of [...byId.values()].filter(r=>r.kind==='candidateQuoteAnchor'&&anchorValid(r,byId.get('candidate:'+r.candidateId)??{})).sort((a,b)=>a.quote.at-b.quote.at)){
  const c=byId.get('candidate:'+a.candidateId);
  for(const horizonMs of CANDIDATE_HORIZONS){const key=JSON.stringify([c.policy,c.executionQualityVersion,c.pair,horizonMs]),last=lasts[key],nonOverlap=last===undefined||a.quote.at-last>=horizonMs;if(nonOverlap)lasts[key]=a.quote.at;flags.set(a.candidateId+':'+horizonMs,nonOverlap);}
 }
 return {flags,lasts};
}

export function reviewSpotCandidates(records,options={}){return reviewCandidates(records,options);}
function reviewCandidates(records,{createdFrom=-Infinity,createdBefore=Infinity}={},checkpointFlags){
 const unique=new Map(),conflicts=new Set();for(const r of records){if(unique.has(r.recordId)&&hash(unique.get(r.recordId))!==hash(r))conflicts.add(r.recordId);else unique.set(r.recordId,r);}
 const flags=checkpointFlags??nonOverlapEvidence(unique).flags,inRange=c=>c&&c.createdAt>=createdFrom&&c.createdAt<createdBefore;
 const groups=new Map(),issues=[...conflicts].map(recordId=>({reason:'CONFLICTING_RECORD',recordId}));let unavailable=0,overlapExcluded=0;
 for(const r of unique.values())if(r.kind==='initialSpotCandidate'&&!candidateValid(r,r.recordedAt))issues.push({reason:'CANDIDATE_INVALID',recordId:r.recordId});
 for(const r of unique.values())if(r.kind==='candidateQuoteAnchor'&&!anchorValid(r,unique.get('candidate:'+r.candidateId)??{}))issues.push({reason:'ANCHOR_INVALID',recordId:r.recordId});
 for(const r of unique.values()){
  if(conflicts.has(r.recordId)||r.kind!=='hypotheticalCandidateQuoteMarkout')continue;
  const a=unique.get('candidate:'+r.candidateId),anchor=unique.get('candidate-anchor:'+r.candidateId);
  if(a&&!inRange(a))continue;
  if(!a||conflicts.has(a.recordId)||!candidateValid(a,r.recordedAt)||!identity(r,a)||r.recordId!==`candidate-markout:${a.candidateId}:${r.horizonMs}`||!CANDIDATE_HORIZONS.includes(r.horizonMs)||!integer(r.recordedAt)||r.recordedAt<a.createdAt||hash(a.qualifications)!==hash(r.qualifications)||r.additionalCostBps!==(a.cost?.additionalCostBps??null)){issues.push({reason:'CANDIDATE_JOIN_INVALID',recordId:r.recordId});continue;}
  if(r.status==='unavailable'){
   if(anchor||r.reason!=='NO_POST_DECISION_ANCHOR_QUOTE'||r.recordedAt<=a.createdAt+20000||r.anchorAt!==null||r.anchorAsk!==null||r.targetAt!==null||r.nonOverlap!==null||r.futureQuote!==null||r.rawQuoteMarkoutBps!==null||r.estimatedAfterAdditionalCostBps!==null)issues.push({reason:'MARKOUT_INVALID',recordId:r.recordId});else unavailable++;
   continue;
  }
  if(!anchorValid(anchor,a)||conflicts.has(anchor.recordId)||anchor.quote.at!==r.anchorAt||anchor.quote.ask!==r.anchorAsk||r.targetAt!==r.anchorAt+r.horizonMs||typeof r.nonOverlap!=='boolean'||r.nonOverlap!==flags.get(a.candidateId+':'+r.horizonMs)||r.recordedAt<anchor.recordedAt){issues.push({reason:'ANCHOR_JOIN_INVALID',recordId:r.recordId});continue;}
  if(!r.nonOverlap){overlapExcluded++;continue;}
  const key=JSON.stringify([r.policy,r.executionQualityVersion,r.horizonMs,r.qualifications.initialOrderCandidate,r.qualifications.costRisk]);
  if(!groups.has(key))groups.set(key,{policy:r.policy,executionQualityVersion:r.executionQualityVersion,horizonMs:r.horizonMs,initialOrderCandidate:r.qualifications.initialOrderCandidate,costRisk:r.qualifications.costRisk,observed:0,missing:0,costKnown:0,raw:[],net:[]});
  const g=groups.get(key);if(r.status==='missing'){
   if(r.reason!=='NO_FRESH_QUOTE_WITHIN_20S'||r.recordedAt<=r.targetAt+20000||r.futureQuote!==null||r.rawQuoteMarkoutBps!==null||r.estimatedAfterAdditionalCostBps!==null)issues.push({reason:'MARKOUT_INVALID',recordId:r.recordId});else g.missing++;
   continue;
  }
  try{
   const q=r.futureQuote,raw=positive(q.bid).div(anchor.quote.ask).minus(1).mul(10000),net=a.cost?raw.minus(a.cost.additionalCostBps):null;
   if(r.status!=='observed'||r.reason!==null||!quoteValid(q)||q.pair!==a.pair||q.at<r.targetAt||q.observedAt>r.targetAt+20000||q.observedAt>r.recordedAt||!raw.eq(r.rawQuoteMarkoutBps)||(net===null?r.estimatedAfterAdditionalCostBps!==null:!net.eq(r.estimatedAfterAdditionalCostBps)))throw Error();
   g.observed++;g.raw.push(raw);if(net){g.net.push(net);g.costKnown++;}
  }catch{issues.push({reason:'MARKOUT_INVALID',recordId:r.recordId});}
 }
 const mean=values=>values.length?values.reduce((a,b)=>a.plus(b),new D(0)).div(values.length).toFixed():null;
 const unresolvedHorizons=[...unique.values()].filter(r=>r.kind==='initialSpotCandidate'&&inRange(r)).reduce((n,c)=>n+CANDIDATE_HORIZONS.filter(h=>!unique.has(`candidate-markout:${c.candidateId}:${h}`)).length,0);
 return {version:CANDIDATE_VERSION,status:issues.length?'incomplete_evidence':unresolvedHorizons?'collecting':'observed',issues,
  candidates:[...unique.values()].filter(r=>r.kind==='initialSpotCandidate'&&inRange(r)&&!conflicts.has(r.recordId)).length,unavailableHorizons:unavailable,overlapExcluded,
  unresolvedHorizons,
  cohorts:[...groups.values()].map(({raw,net,...g})=>({...g,averageRawQuoteMarkoutBps:mean(raw),averageEstimatedAfterAdditionalCostBps:mean(net)})),
  coverage:'Persisted candidates only. Workflow-to-journal coverage is not reconciled; an in-memory queue or process failure can omit initial candidates. Unresolved horizons are not scored.',
  note:'Initial candidates, not fully bridge-qualified orders or actual net trading profits. Missing costs/outcomes do not become zero. Nonoverlap per pair/policy/quality/horizon; pairs remain correlated.'};
}

// Recover only already journaled observations, never unseen historical quotes.
// This also covers append+fsync succeeding before the atomic state write fails.
export function recoverSpotCandidateState(state,records,now){
 if(state)return recoverFromCheckpoint(state,records,now);
 if(!integer(now)||reviewSpotCandidates(records).issues.length)throw Error('CANDIDATE_JOURNAL_INVALID');
 const byId=new Map(records.map(r=>[r.recordId,r])),next=newSpotCandidateState(state?.lastNow??now);
 if(state&&(state.version!==CANDIDATE_VERSION||!integer(state.lastNow)||!Array.isArray(state.pending)))throw Error('CANDIDATE_STATE_INVALID');
 const {flags,lasts}=nonOverlapEvidence(byId);next.nonOverlap=lasts;
 for(const row of byId.values())if(row.kind==='initialSpotCandidate'){
  const {recordedAt,...c}=row,anchor=byId.get('candidate-anchor:'+c.candidateId)??null;
  const pending=pendingFor(c).filter(p=>!byId.has(`candidate-markout:${c.candidateId}:${p.horizonMs}`));
  if(pending.length||now-c.createdAt<=1800000)next.seen[c.candidateId]={at:c.createdAt,hash:hash(c)};
  for(const p of pending){p.anchor=anchor;p.nonOverlap=anchor?flags.get(c.candidateId+':'+p.horizonMs):null;next.pending.push(p);}
 }
 if(next.pending.length>1024)throw Error('CANDIDATE_RECOVERY_CAPACITY');
 // A state row must have an immutable candidate; never trust orphan state.
 if(state?.pending.some(p=>!byId.has('candidate:'+p.candidate?.candidateId)))throw Error('CANDIDATE_STATE_ORPHAN');
 return next;
}

export function validateSpotCandidateState(state,now){
 if(state?.version!==CANDIDATE_VERSION||!integer(state.lastNow)||state.lastNow>now||!Array.isArray(state.pending)||state.pending.length>1024||typeof state.seen!=='object'||!state.seen||Array.isArray(state.seen)||typeof state.nonOverlap!=='object'||!state.nonOverlap||Array.isArray(state.nonOverlap))throw Error('CANDIDATE_STATE_INVALID');
 const ids=new Set();
 for(const p of state.pending){if(!p||typeof p!=='object'||Array.isArray(p))throw Error('CANDIDATE_STATE_INVALID');const c=p.candidate,id=c?.candidateId+':'+p.horizonMs;
  if(!candidateValid(c,state.lastNow)||!CANDIDATE_HORIZONS.includes(p.horizonMs)||ids.has(id)||(p.anchor===null?p.nonOverlap!==null:!anchorValid(p.anchor,c)||p.anchor.recordedAt>state.lastNow||typeof p.nonOverlap!=='boolean')||state.seen[c.candidateId]?.hash!==hash(c))throw Error('CANDIDATE_STATE_INVALID');ids.add(id);
 }
 for(const [id,v]of Object.entries(state.seen))if(!/^[a-f0-9]{64}$/.test(id)||!integer(v?.at)||v.at>state.lastNow||!/^[a-f0-9]{64}$/.test(v.hash))throw Error('CANDIDATE_STATE_INVALID');
 for(const [key,value]of Object.entries(state.nonOverlap)){let parts;try{parts=JSON.parse(key);}catch{throw Error('CANDIDATE_STATE_INVALID');}if(!Array.isArray(parts)||parts.length!==4||!CANDIDATE_HORIZONS.includes(parts[3])||!integer(value)||value>state.lastNow)throw Error('CANDIDATE_STATE_INVALID');}
 return state;
}

function recoverFromCheckpoint(state,records,now){
 validateSpotCandidateState(state,now);const next=structuredClone(state),byId=new Map();
 for(const r of records){if(byId.has(r.recordId)&&hash(byId.get(r.recordId))!==hash(r))throw Error('CANDIDATE_JOURNAL_INVALID');byId.set(r.recordId,r);}
 const strip=r=>{const {recordedAt,...c}=r;return c;};
 for(const p of next.pending){const row=byId.get('candidate:'+p.candidate.candidateId),anchor=byId.get('candidate-anchor:'+p.candidate.candidateId);
  if(!row||hash(strip(row))!==hash(p.candidate)||(p.anchor&&(!anchor||hash(p.anchor)!==hash(anchor))))throw Error('CANDIDATE_STATE_ORPHAN');
 }
 for(const row of byId.values())if(row.kind==='initialSpotCandidate'&&row.recordedAt>=state.lastNow&&!next.seen[row.candidateId]){
  const c=strip(row);if(!candidateValid(c,now)||c.createdAt<state.lastNow)throw Error('CANDIDATE_JOURNAL_INVALID');next.seen[c.candidateId]={at:c.createdAt,hash:hash(c)};next.pending.push(...pendingFor(c));
 }
 for(const anchor of [...byId.values()].filter(r=>r.kind==='candidateQuoteAnchor').sort((a,b)=>a.quote.at-b.quote.at)){
  const pending=next.pending.filter(p=>p.candidate.candidateId===anchor.candidateId);
  for(const p of pending){if(!anchorValid(anchor,p.candidate))throw Error('CANDIDATE_JOURNAL_INVALID');if(p.anchor)continue;
   p.anchor=anchor;const c=p.candidate,key=JSON.stringify([c.policy,c.executionQualityVersion,c.pair,p.horizonMs]),last=next.nonOverlap[key];p.nonOverlap=last===undefined||anchor.quote.at-last>=p.horizonMs;if(p.nonOverlap)next.nonOverlap[key]=anchor.quote.at;
  }
 }
 const flags=new Map(next.pending.filter(p=>p.anchor).map(p=>[p.candidate.candidateId+':'+p.horizonMs,p.nonOverlap])),ids=new Set(next.pending.map(p=>p.candidate.candidateId)),pendingIds=new Set(next.pending.map(p=>p.candidate.candidateId+':'+p.horizonMs));
 const relevant=records.filter(r=>ids.has(r.candidateId)&&(r.kind!=='hypotheticalCandidateQuoteMarkout'||pendingIds.has(r.candidateId+':'+r.horizonMs)));if(reviewCandidates(relevant,{},flags).issues.length)throw Error('CANDIDATE_JOURNAL_INVALID');
 next.pending=next.pending.filter(p=>!byId.has(`candidate-markout:${p.candidate.candidateId}:${p.horizonMs}`));
 if(next.pending.length>1024)throw Error('CANDIDATE_RECOVERY_CAPACITY');return next;
}

// Streaming audit retains only unfinished observations plus the requested day's
// records. Earlier immutable anchors establish the greedy nonoverlap phase.
export function createSpotCandidateReviewAccumulator({createdFrom,createdBefore}){
 const active=new Map(),lasts={},flags=new Map(),selected=[],selectedIds=new Set(),selectedDigests=new Map();
 const keep=r=>{if(selected.length>=32768)throw Error('CANDIDATE_REVIEW_CAPACITY');selected.push(r);selectedDigests.set(r.recordId,hash(r));};
 return {
  consume(r){
   if(selectedDigests.has(r?.recordId)){if(selectedDigests.get(r.recordId)!==hash(r))throw Error('CANDIDATE_JOURNAL_INVALID');return;}
   if(r?.kind==='initialSpotCandidate'){
    if(!candidateValid(r,r.recordedAt))throw Error('CANDIDATE_JOURNAL_INVALID');
    const old=active.get(r.candidateId);if(old){if(hash(old.candidate)!==hash(r))throw Error('CANDIDATE_JOURNAL_INVALID');return;}
    if(active.size>=1024)throw Error('CANDIDATE_REVIEW_CAPACITY');active.set(r.candidateId,{candidate:r,anchor:null,horizons:new Set()});
    if(r.createdAt>=createdFrom&&r.createdAt<createdBefore){selectedIds.add(r.candidateId);keep(r);}return;
   }
   const entry=active.get(r?.candidateId);if(!entry)throw Error('CANDIDATE_JOURNAL_ORPHAN');
   if(r.kind==='candidateQuoteAnchor'){
    if(!anchorValid(r,entry.candidate))throw Error('CANDIDATE_JOURNAL_INVALID');
    if(entry.anchor){if(hash(entry.anchor)!==hash(r))throw Error('CANDIDATE_JOURNAL_INVALID');return;}entry.anchor=r;
    for(const horizon of CANDIDATE_HORIZONS){const c=entry.candidate,key=JSON.stringify([c.policy,c.executionQualityVersion,c.pair,horizon]),last=lasts[key],nonOverlap=last===undefined||r.quote.at-last>=horizon;if(nonOverlap)lasts[key]=r.quote.at;if(selectedIds.has(c.candidateId))flags.set(c.candidateId+':'+horizon,nonOverlap);}
   }else if(r.kind==='hypotheticalCandidateQuoteMarkout'){
    if(!CANDIDATE_HORIZONS.includes(r.horizonMs)||r.recordId!==`candidate-markout:${r.candidateId}:${r.horizonMs}`)throw Error('CANDIDATE_JOURNAL_INVALID');entry.horizons.add(r.horizonMs);
   }else throw Error('CANDIDATE_JOURNAL_INVALID');
   if(selectedIds.has(r.candidateId))keep(r);
   if(entry.horizons.size===3)active.delete(r.candidateId);
  },
  finish(){return reviewCandidates(selected,{},flags);}
 };
}
