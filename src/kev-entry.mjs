// Demo entry reviewer. The order-flow route supplies both permitted futures
// directions and lets Kev choose the pair and side, or HOLD. The native bridge
// still owns sizing, execution, position limits and protection.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import Decimal from 'decimal.js';
import {ROOT} from './paths.mjs';
import {readJson,exists} from './io.mjs';
import {isEntry} from './mode.mjs';
import {executableCostEconomics} from './trading-costs.mjs';

export const KEV_ENTRY_VERSION='kev-codex-entry-v1';
const Config=z.object({version:z.literal(KEV_ENTRY_VERSION),baseUrl:z.literal('http://127.0.0.1:8009'),
 model:z.literal('kev-codex'),expectedModel:z.string().min(1).max(100),timeoutMs:z.number().int().min(2000).max(20000),
 executionReserveMs:z.number().int().min(10000).max(20000),approvalTtlMs:z.literal(60000),
 maxCandidates:z.number().int().min(1).max(20),decisionMode:z.enum(['approval','autonomous']).default('approval'),
 marketData:z.enum(['kronos','order-flow']).default('kronos'),
 decisionStyle:z.enum(['balanced','aggressive']).default('balanced')}).strict();
const Activation=z.object({version:z.literal(KEV_ENTRY_VERSION),enabled:z.boolean(),mode:z.enum(['demo','demo-futures']),
 activatedAt:z.iso.datetime(),decisionMode:z.enum(['approval','autonomous']).optional()}).strict();
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
export const kevDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

export async function loadKevEntryConfig({local,mode,root=ROOT}){
 const config=Config.parse(await readJson(join(root,'config/kev-entry.json')));
 const file=join(local,'kev-entry.json');
 const activation=await exists(file)?Activation.parse(await readJson(file)):null;
 if(activation&&activation.mode!==mode)throw Error('KEV_ACTIVATION_MODE_MISMATCH');
 const decisionMode=activation?.decisionMode??config.decisionMode;
 if(activation?.decisionMode&&activation.decisionMode!==config.decisionMode)throw Error('KEV_DECISION_MODE_MISMATCH');
 return {...config,decisionMode,enabled:['demo','demo-futures'].includes(mode)&&activation?.enabled===true};
}

const isKevFlow=snapshot=>snapshot.entryPolicyVersion==='kev-order-flow-v1';
function reviewDeadline(snapshot){
 if(!isKevFlow(snapshot))return snapshot.candleBoundary+60000;
 return snapshot.timeframe==='order-flow'&&!Object.hasOwn(snapshot,'candleBoundary')&&snapshot.decisionCadenceVersion==='flow-minute-v1'&&
  snapshot.decisionIntervalMs===60000&&Number.isSafeInteger(snapshot.decisionBoundary)&&snapshot.decisionBoundary>0&&snapshot.decisionBoundary%60000===0
  ?snapshot.decisionBoundary+60000:NaN;
}

// Summaries describe the full sampled tape; the explicitly bounded raw sample
// helps Kev inspect recent prints without claiming this REST sampler is tick HFT.
// Every field is allowlisted, so extra exchange/local fields never reach the CLI.
const compactDecimal=value=>typeof value==='string'&&/^\d+\.\d+$/.test(value)
 ?value.replace(/(\.\d*?[1-9])0+$/,'$1').replace(/\.0+$/,''):value;
function flowEvidence(proof){
 if(!proof)return null;
 const books=(proof.books??[]).map(b=>({at:b.at,updateId:b.updateId,
  bids:(b.bids??[]).slice(0,5).map(l=>[compactDecimal(l[0]),compactDecimal(l[1])]),
  asks:(b.asks??[]).slice(0,5).map(l=>[compactDecimal(l[0]),compactDecimal(l[1])])}));
 const trades=proof.trades??[];
 try{
  let buy=new Decimal(0),sell=new Decimal(0);
  for(const t of trades){const n=new Decimal(t.p).mul(t.q);if(t.m)sell=sell.plus(n);else buy=buy.plus(n);}
  const total=buy.plus(sell),mids=books.map(b=>new Decimal(b.bids[0][0]).plus(b.asks[0][0]).div(2));
  const bookImbalances=books.map(b=>{
   const sums=[b.bids,b.asks].map(levels=>levels.reduce((n,[p,q])=>n.plus(new Decimal(p).mul(q)),new Decimal(0)));
   return sums[0].minus(sums[1]).div(sums[0].plus(sums[1])).toFixed();
  });
  return {version:proof.version,source:proof.source,mode:proof.mode,pair:proof.pair,
   windowStart:proof.startTime,windowEnd:proof.endTime,tradeCount:trades.length,
   metrics:{takerBuyNotional:buy.toFixed(),takerSellNotional:sell.toFixed(),takerBuyShare:total.gt(0)?buy.div(total).toFixed():null,
    bookImbalances,midPriceChangeBps:mids.length?mids.at(-1).div(mids[0]).minus(1).mul(10000).toFixed():null},
   books,recentTradeSample:trades.slice(-8).map(t=>({a:t.a,p:compactDecimal(t.p),q:compactDecimal(t.q),T:t.T,m:t.m})),
   rawTradeSampleLimit:8,rawTradeSampleIsComplete:trades.length<=8};
 }catch{return null;}
}

// Aggressive mode keeps the model call small enough to finish inside the
// one-minute decision window.  This score only chooses which public
// candidates are shown to Kev; it never approves an order or changes the
// native direction/cost/quote guards.
function flowShortlistScore(market,action){
 try{
  const metrics=flowEvidence(market?.orderFlow)?.metrics;
  if(!metrics)return -Infinity;
  const buy=new Decimal(metrics.takerBuyNotional),sell=new Decimal(metrics.takerSellNotional),total=buy.plus(sell);
  if(total.lte(0))return -Infinity;
  const long=action!=='open-short',share=(long?buy:sell).div(total),depth=(metrics.bookImbalances??[])
   .map(value=>new Decimal(value)).filter(value=>value.isFinite()).reduce((sum,value)=>sum.plus(long?value:value.neg()),new Decimal(0));
  const move=new Decimal(metrics.midPriceChangeBps??0),directionalMove=long?move:move.neg();
  return share.minus('.5').mul(100).plus(depth.mul(20)).plus(directionalMove).toNumber();
 }catch{return -Infinity;}
}

function candidatesFor(reference,snapshot,account,config){
 const available=(reference.candidates??[]).filter(c=>isEntry(c.action)&&Number(c.stakeUsdt)>0&&
  c.nativeEligible!==false&&
  !(account?.trades??[]).some(t=>t.pair===c.pair));
if(isKevFlow(snapshot)){
  // Balanced mode keeps the full pool, including opposite directions for the
  // same contract. Aggressive mode uses only a small public-flow shortlist so
  // the Codex call can complete before the minute deadline; Kev still chooses
  // the final pair/direction or HOLD from that shortlist.
  let pool=available;
  if(config.decisionStyle==='aggressive'&&available.length>config.maxCandidates){
   pool=available.map((candidate,index)=>({...candidate,__flowRankScore:flowShortlistScore(snapshot.markets.find(m=>m.pair===candidate.pair),candidate.action),__flowRankIndex:index}))
    .sort((a,b)=>b.__flowRankScore-a.__flowRankScore||a.__flowRankIndex-b.__flowRankIndex).slice(0,config.maxCandidates);
  }else if(available.length>config.maxCandidates)throw Error('KEV_CANDIDATE_POOL_TOO_LARGE');
  const identities=new Set();
  return pool.map((c,i)=>{
   const key=c.pair+'|'+c.action;
   if(identities.has(key))throw Error('KEV_CANDIDATE_DUPLICATE');identities.add(key);
   const market=snapshot.markets.find(m=>m.pair===c.pair);
   if(!market)throw Error('KEV_MARKET_MISSING');
   // Shared narrative assumptions belong once in the prompt, not in every
   // candidate: preserve room for the full public order-flow evidence pool.
   const {basis,feeAssumption,stopScenario,entryQuotePrice,currentExitQuotePrice,
    slippageBpsPerSide,fundingReserveBps,...costEconomics}=executableCostEconomics({
    mode:snapshot.mode,action:c.action,market,stopFraction:c.stopFraction,targetFraction:c.targetFraction});
   const netMargin=c.netMargin?{
    version:c.netMargin.version,
    targetNetMarginBps:c.netMargin.targetNetMarginBps,
    quoteDriftReserveBps:c.netMargin.quoteDriftReserveBps,
    netMarginAfterQuoteDriftBps:c.netMargin.netMarginAfterQuoteDriftBps,
    minimumNetMarginBps:c.netMargin.minimumNetMarginBps
   }:null;
   return {id:'q'+i,pair:c.pair,action:c.action,stopFraction:c.stopFraction,targetFraction:c.targetFraction,
    maxHoldingSeconds:c.maxHoldingSeconds,...(Number.isFinite(c.__flowRankScore)?{flowShortlist:{version:'kev-flow-shortlist-v1',rankScoreBps:String(c.__flowRankScore)}}:{}),costEconomics,netMargin};
 });
}
 available.sort((a,b)=>Number(b.pair===reference.selected?.pair)-Number(a.pair===reference.selected?.pair)||
  Number(b.selectionScoreBps)-Number(a.selectionScoreBps)||a.pair.localeCompare(b.pair));
 return available.slice(0,config.maxCandidates).map((c,i)=>{
  const m=snapshot.markets.find(m=>m.pair===c.pair);
  if(!m)throw Error('KEV_MARKET_MISSING');
  const confirmation=c.entryConfirmation??{};
  // Explicit public-market/strategy allowlist. Never send account balances,
  // trade history, full snapshots, local paths, credentials or arbitrary evidence.
  return {id:'q'+i,pair:c.pair,action:c.action,bid:m.bid,ask:m.ask,spreadBps:m.spreadBps,
   quoteObservedAt:m.fetchedAt,requiredPriceSpaceBps:c.requiredPriceSpaceBps,
   forecastSurplusBps:c.selectionScoreBps,atr15:c.atr15,stopFraction:c.stopFraction,targetFraction:c.targetFraction,
   originClose:confirmation.originClose,forecastCloses:confirmation.forecastCloses,
   lastClosedCandles:(m.candles??[]).slice(-6).map(b=>({closeTime:b.closeTime,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume})),
   modelEvidence:{fingerprint:c.model?.modelFingerprint,predictionSha256:c.model?.predictionSha256}};
 });
}

const KEV_MICROSTRUCTURE_ROLE='你是加密貨幣自主訂單流套利專家 Kev，負責 Demo 環境中的積極候選選擇。本策略的核心目標是：在 60 秒的窗口內，必須極其敏銳地捕捉任何短線微結構的失衡機會，主動尋求交易回報。';
const KEV_MICROSTRUCTURE_CONTEXT=`${KEV_MICROSTRUCTURE_ROLE}

【核心限制與防禦邊界】

1. 只能從系統提供的候選 pair/action 中選擇一個，或選擇 HOLD。嚴禁自行創造或修改任何交易對、方向、價格、數量、槓桿或保護參數。
2. 系統已預先執行硬性風控檢查。candidateDiagnostics 僅供說明被移除的原因，絕不能繞過任何硬性限制。
3. 不得重算或修改系統提供的任何數值，亦不得自行捏造機率、預測或外部未提供的資訊。

【雙重確認與淨邊際過濾】

1. 主動成交（Trades）的方向與掛單簿（Order Book）的方向必須同時明確且一致，才是 live 候選。掛單簿方向以最新兩個深度樣本一致為準，第一個樣本允許是單一雜訊；只有一側支持、最新兩個樣本方向失配、或深度方向混合的訊號屬於 shadowSignals，只能觀察與記錄，嚴禁選取送單。
2. costEconomics 已扣除手續費、買賣價差、雙邊滑價與合約資金費預留；並且已保留報價漂移預算。只有 targetNetMarginBps 扣除 quoteDriftReserveBps 後仍不低於 minimumNetMarginBps 的候選，才允許選取。
3. 只在通過雙重方向確認與淨邊際硬性檢查的 q0、q1、q2 中比較。若沒有 live 候選，必須選 hold；不得為了增加頻率而把 shadowSignals 當成可下單候選。

這是 aggressive entry profile 的高頻決策，但高頻不代表忽略成本。系統已執行報價、容量、風控、時限與保護檢查；candidateDiagnostics 與 shadowSignals 絕不能覆寫硬性限制。進場 ask/bid 與退出 bid/ask already include the spread; do not deduct it again。不得改變系統提供的價格、數量、槓桿、方向或保護參數。

【60 秒決策窗口與嚴格輸出格式】

請在本次 60 秒決策窗口內完成評估。只在 choice 欄位輸出 q0、q1、q2 或 hold（HOLD）；不得輸出任何解釋、前言、後記、推理過程或其他字元。`;
const KEV_MICROSTRUCTURE_INSTRUCTIONS=`Aggressive profile：在 60 秒窗口內比較所有系統提供的 live q 候選，核對 Trades 與最新兩個 Order Book 深度樣本的方向是否一致，以及 costEconomics 的 targetNetMarginBps、quoteDriftReserveBps、minimumNetMarginBps。shadowSignals 僅供記錄，永遠不得選取。只有雙重方向一致且淨邊際扣除報價漂移後仍達最低門檻的候選才可選；若沒有這類候選必須選 hold。若有多個 live 候選，選成本後淨邊際與方向性證據相對最強者。cost-adjusted case is missing, weak, stale or contradictory 時必須選 hold，不得以積極設定繞過成本硬性檢查。不要發明或修改 pair、方向、價格、數量、槓桿、保護參數、機率或預測。系統會執行所有原生硬性檢查並使用所選候選的原始參數。最終 choice 只能是 q0、q1、q2 或 hold（HOLD），不得附帶任何其他字元。`;

function requestFor(snapshot,candidates,config,reference){
 const aggressive=config.decisionStyle==='aggressive';
 const common={mode:snapshot.mode,snapshotId:snapshot.id,observedAt:snapshot.completedAt??snapshot.createdAt,
  decisionMode:config.decisionMode,cadence:snapshot.decisionCadenceVersion??'flow-minute-v1',
  decisionIntervalMs:snapshot.decisionIntervalMs??60000,decisionStyle:config.decisionStyle??'balanced',candidates,
  candidateDiagnostics:null,
  shadowSignals:(reference?.metadata?.shadowCandidates??[]).map(c=>({pair:c.pair,action:c.requestedAction,reason:c.shadowReason,
   tapeDirection:c.flowDiagnostics?.tapeDirection??null,bookDirection:c.flowDiagnostics?.bookDirection??null,
   takerShare:c.flowDiagnostics?.takerShare??null,bookImbalances:c.flowDiagnostics?.bookImbalances??null}))};
 if(isKevFlow(snapshot))return {model:config.model,state:{...common,
  marketData:'order-flow',entryPolicyVersion:snapshot.entryPolicyVersion,
  decisionBoundary:snapshot.decisionBoundary,expiresAt:new Date(reviewDeadline(snapshot)).toISOString(),
  markets:[...new Set(candidates.map(c=>c.pair))].map(pair=>{
   const m=snapshot.markets.find(m=>m.pair===pair);
   return {pair,bid:m.bid,ask:m.ask,spreadBps:m.spreadBps,quoteObservedAt:m.fetchedAt,
    costs:m.entryCost?{estimatedRoundTripCostBps:m.entryCost.estimatedRoundTripCostBps,
     requiredPriceSpaceBps:m.entryCost.requiredPriceSpaceBps,roundTripFeeBps:m.entryCost.roundTripFeeBps,
     slippageBpsPerSide:m.entryCost.slippageBpsPerSide,fundingReserveBps:m.entryCost.fundingReserveBps,
     observedAt:m.entryCost.observedAt}:undefined,
    orderFlow:flowEvidence(m.orderFlow)};
  }),
  role:KEV_MICROSTRUCTURE_ROLE,
  context:KEV_MICROSTRUCTURE_CONTEXT,
  highFrequency:true},questions:{entry:{type:'choice',
   instructions:KEV_MICROSTRUCTURE_INSTRUCTIONS,
   criteria:Object.fromEntries([...candidates.map(c=>[c.id,'Choose '+c.id+' ('+c.pair+', '+c.action+') subject to native checks.']),['hold','Do not enter this decision window.']])}}};
 if(config.decisionMode==='autonomous')return {model:config.model,state:{...common,
  role:'Demo autonomous candidate selection, not an order. Kev may choose one existing native-eligible candidate or HOLD; native cost, quote, time, size, position and protection guards remain mandatory.',
  context:'Kronos supplies every candidate direction. The list is the complete native-eligible pool for this snapshot, not just the deterministic top rank. Choose at most one supplied candidate or HOLD for this 60-second decision window. Do not invent a pair or direction, reverse direction, change size, price, leverage or protection, demand unavailable research, or claim profitability.',
  highFrequency:true},questions:{entry:{type:'choice',
   instructions:'Select the single existing candidate with the strongest coherent short-term case, or HOLD when the supplied evidence is missing, contradictory or not worth the modeled execution cost. The host will enforce all native checks and use only the selected candidate parameters.',
   criteria:Object.fromEntries([...candidates.map(c=>[c.id,'Select existing '+c.id+' ('+c.pair+', '+c.action+') subject to all native checks.']),['hold','Do not enter this decision window.']])}}};
 return {model:config.model,state:{...common,
  role:'Demo entry approval, not an order. Native cost, quote, time, size, position and protection guards remain mandatory.',
  context:'Kronos supplies candidate direction. Forecast surplus and ATR are not expected profit. No calibrated win-rate threshold is required. Missing order flow is not a mandatory gate for this strategy.',
  highFrequency:true},questions:Object.fromEntries(candidates.map(c=>[c.id,{type:'choice',
   instructions:'Review only candidate '+c.id+' ('+c.pair+', '+c.action+'). Approve when the supplied candidate is coherent and has no clear adverse or contradictory short-term evidence. Hold if required candidate facts are missing, inconsistent, or supplied price context clearly contradicts the entry. Do not demand unavailable external research, invent facts, reverse direction, change size, or claim profitability.',
   criteria:{approve:'Agree with this existing candidate, subject to all native checks.',hold:'Decline this candidate for this snapshot.'}}]))};
}

function seal(value){return {...value,proofSha256:kevDigest(value)};}
function unseal(review){const {proofSha256,...body}=review;return proofSha256===kevDigest(body);}
const reasonForError=e=>e?.name==='TimeoutError'||e?.name==='AbortError'?'KEV_TIMEOUT_OR_ABORTED':
 /^KEV_[A-Z_]+$/.test(e?.message??'')?e.message:'KEV_SERVICE_UNAVAILABLE';

export async function reviewKevEntries({reference,snapshot,policy,account,config,signal,fetchImpl=fetch,now=Date.now}){
 const started=now(),base={version:KEV_ENTRY_VERSION,enabled:config.enabled,mode:policy.mode,snapshotId:snapshot.id,
  snapshotSha256:kevDigest(snapshot),configSha256:kevDigest(config),startedAt:new Date(started).toISOString(),
  decisionMode:config.decisionMode,invoked:false,requestAttempted:false,approvedPairs:[],decisions:[],
  candidateDiagnostics:reference.metadata?.candidateDiagnostics??null};
 if(!config.enabled)return seal({...base,status:'disabled',reason:'KEV_DISABLED'});
 if(!['demo','demo-futures'].includes(policy.mode)||snapshot.mode!==policy.mode)throw Error('KEV_DEMO_ONLY');
 if(config.decisionMode!=='autonomous'&&!isEntry(reference.proposal.action))
  return seal({...base,status:'not_requested',reason:'KEV_NO_ELIGIBLE_ENTRY'});
 if(isKevFlow(snapshot)&&(config.decisionMode!=='autonomous'||config.marketData!=='order-flow'))
  return seal({...base,status:'hold',reason:'KEV_ORDER_FLOW_CONFIG_MISMATCH'});
 let candidates;
 try{candidates=candidatesFor(reference,snapshot,account,config);}
 catch(error){return seal({...base,status:'hold',reason:reasonForError(error)});}
 if(!candidates.length)return seal({...base,status:'not_requested',reason:'KEV_NO_ELIGIBLE_ENTRY'});
 const deadline=reviewDeadline(snapshot);
 const timeoutMs=Math.min(config.timeoutMs,deadline-started-config.executionReserveMs-1000);
 if(!Number.isSafeInteger(deadline)||(isKevFlow(snapshot)&&started<snapshot.decisionBoundary)||timeoutMs<2000||signal?.aborted)
  return seal({...base,status:'hold',reason:'KEV_INSUFFICIENT_ENTRY_TIME'});
 const request=requestFor(snapshot,candidates,config,reference);
 request.state.candidateDiagnostics=reference.metadata?.candidateDiagnostics??null;
 if(isKevFlow(snapshot)&&request.state.markets.some(m=>!m.orderFlow))
  return seal({...base,status:'hold',reason:'KEV_ORDER_FLOW_EVIDENCE_MISSING'});
 if(Buffer.byteLength(JSON.stringify(request))>32768)return seal({...base,status:'hold',reason:'KEV_REQUEST_TOO_LARGE'});
 try{
  const timeout=AbortSignal.timeout(timeoutMs+1000),abort=signal?AbortSignal.any([timeout,signal]):timeout;
  base.requestAttempted=true;base.invoked=null;
  const response=await fetchImpl(config.baseUrl+'/v1/systemone',{method:'POST',redirect:'error',signal:abort,
   headers:{'Content-Type':'application/json','X-Kev-Timeout-Ms':String(timeoutMs)},body:JSON.stringify(request)});
  if(!response.ok)throw Error(response.status===429?'KEV_BUSY_OR_LIMIT':response.status===504?'KEV_TIMEOUT':'KEV_HTTP_ERROR');
  const text=await response.text();if(text.length>65536)throw Error('KEV_RESPONSE_TOO_LARGE');
  const result=JSON.parse(text),backend=result.backend;
  if(result.model!==config.model||backend?.name!=='codex-cli'||backend.actual_model!==config.expectedModel||
   backend.weights_loaded!==false||backend.probabilities_calibrated!==false||backend.cli_calls!==1||
   typeof result.request_id!=='string'||!result.request_id||result.request_id.length>100||
   !Number.isInteger(result.usage?.input_tokens)||result.usage.input_tokens<1||
   !Number.isInteger(result.usage?.output_tokens)||result.usage.output_tokens<1)throw Error('KEV_BACKEND_MISMATCH');
  base.invoked=true;
  const completed=now(),remote=Date.parse(result.created_at);
  if(!Number.isFinite(remote)||remote<started-2000||remote>completed+2000||completed<started||
   completed-started>timeoutMs+1000||completed>=deadline-config.executionReserveMs||signal?.aborted)throw Error('KEV_RESPONSE_STALE');
  if(!result.answers)throw Error('KEV_ANSWERS_INVALID');
  let decisions,selection=null;
  if(config.decisionMode==='autonomous'){
   if(Object.keys(result.answers).length!==1)throw Error('KEV_ANSWERS_INVALID');
   const a=result.answers.entry,p=a?.probabilities,choices=[...candidates.map(c=>c.id),'hold'];
   if(a?.type!=='choice'||!choices.includes(a.choice)||!p||Object.keys(p).sort().join(',')!==[...choices].sort().join(',')||
    choices.some(choice=>typeof p[choice]!=='number'||!Number.isFinite(p[choice])||p[choice]<0||p[choice]>1)||
    Math.abs(choices.reduce((sum,choice)=>sum+p[choice],0)-1)>0.011||
    choices.some(choice=>choice!==a.choice&&p[a.choice]<=p[choice]))throw Error('KEV_ANSWERS_INVALID');
   selection={choice:a.choice,probabilities:p};
   decisions=candidates.map(c=>({pair:c.pair,action:c.action,approved:a.choice===c.id,choice:a.choice===c.id?'select':'hold',probabilities:p}));
  }else{
   if(Object.keys(result.answers).length!==candidates.length)throw Error('KEV_ANSWERS_INVALID');
   decisions=candidates.map(c=>{
    const a=result.answers[c.id],p=a?.probabilities;
    if(a?.type!=='choice'||!['approve','hold'].includes(a.choice)||!p||Object.keys(p).sort().join(',')!=='approve,hold'||
     ![p.approve,p.hold].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1)||Math.abs(p.approve+p.hold-1)>0.011||
     (a.choice==='approve'&&p.approve<p.hold)||(a.choice==='hold'&&p.hold<p.approve))throw Error('KEV_ANSWERS_INVALID');
    return {pair:c.pair,action:c.action,approved:a.choice==='approve'&&p.approve>p.hold,choice:a.choice,probabilities:p};
   });
  }
  return seal({...base,status:'reviewed',reason:null,completedAt:new Date(completed).toISOString(),
   // Match the route's native deadline, independently checked again
   // after RPC queuing at callback, order context and the exchange wire.
   expiresAt:new Date(deadline).toISOString(),
   actualModel:backend.actual_model,requestId:result.request_id,usage:result.usage,latencyMs:completed-started,
   request,response:result,decisions,approvedPairs:decisions.filter(d=>d.approved).map(d=>d.pair),...(selection?{selection}: {})});
 }catch(error){return seal({...base,status:'hold',reason:reasonForError(error),completedAt:new Date(now()).toISOString()});}
}

export function kevEntryRejection({review,snapshot,proposal,config,now=Date.now()}){
 if(!config.enabled||!isEntry(proposal.action))return null;
 if(!review||review.enabled!==true||review.version!==KEV_ENTRY_VERSION||!unseal(review)||
  review.mode!==snapshot.mode||review.snapshotId!==snapshot.id||review.snapshotSha256!==kevDigest(snapshot)||
  review.configSha256!==kevDigest(config))return 'KEV_APPROVAL_MISSING_OR_MISMATCH';
 if(review.status!=='reviewed')return review.reason??'KEV_NOT_APPROVED';
 const completed=Date.parse(review.completedAt),expiry=Date.parse(review.expiresAt);
 if(!Number.isFinite(completed)||!Number.isFinite(expiry)||now<completed||now>=expiry||
  expiry!==reviewDeadline(snapshot)||expiry>completed+config.approvalTtlMs)return 'KEV_APPROVAL_EXPIRED';
 const answer=review.decisions.filter(d=>d.pair===proposal.pair&&d.action===proposal.action);
 if(answer.length!==1||!answer[0].approved)return 'KEV_ENTRY_VETO';
 return null;
}

export function kevBlockedPairs(review,policy){
 return review?.enabled?policy.pairs.filter(pair=>!review.approvedPairs?.includes(pair)):[];
}

export function kevEntryReceipt(review,pair,action){
 if(!review?.enabled||review.status!=='reviewed')return null;
 const decisions=review.decisions.filter(d=>d.pair===pair&&(!action||d.action===action));
 const decision=decisions.find(d=>d.approved)??decisions[0];
 return {version:review.version,decisionMode:review.decisionMode??'approval',provider:'codex-cli',model:review.actualModel,requestId:review.requestId,
  snapshotId:review.snapshotId,snapshotSha256:review.snapshotSha256,configSha256:review.configSha256,proofSha256:review.proofSha256,
  completedAt:review.completedAt,expiresAt:review.expiresAt,
  decision,selection:review.selection??null,probabilitiesCalibrated:false};
}
