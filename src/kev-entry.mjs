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
import {DEMO_PROFIT_PROTECTION} from './demo-rules.mjs';
import {candidateExitEconomics,KEV_SIZED_EXIT_EVIDENCE_VERSION} from './kev-sized-exit-economics.mjs';
import {FLOW_MAX_AGE_MS} from './order-flow.mjs';
import {KEV_NET_HARVEST_POLICY,validKevExitPolicy,reviewedKevExitPolicy} from './kev-exit-policy.mjs';
import {validKevEntrySignalPolicy} from './kev-entry-signal.mjs';
import {reviewedKevEntrySignalPolicy} from './kev-entry-contract.mjs';
import {readProviderSelection,loadJevCredential} from './decision-provider.mjs';
import {callJev} from './jev-client.mjs';
import {JEV_ENTRY_VERSION,JEV_MODEL,JEV_BASE_URL,isJevConfig,reviewerProvider,decisionProviderEvidence,reviewerBackendMatches} from './reviewer-identity.mjs';

export const KEV_ENTRY_VERSION='kev-codex-entry-v1';
export const KEV_FLOW_SHORTLIST_VERSION='kev-flow-shortlist-v2';
export const KEV_FLOW_REQUEST_VERSION='kev-flow-request-v5';
const Config=z.object({version:z.literal(KEV_ENTRY_VERSION),baseUrl:z.literal('http://127.0.0.1:8009'),
 model:z.literal('kev-codex'),expectedModel:z.string().min(1).max(100),timeoutMs:z.number().int().min(2000).max(40000),
 executionReserveMs:z.number().int().min(10000).max(20000),approvalTtlMs:z.literal(60000),
 maxCandidates:z.number().int().min(1).max(20),decisionMode:z.enum(['approval','autonomous']).default('approval'),
 marketData:z.enum(['kronos','order-flow']).default('kronos'),
 decisionStyle:z.literal('balanced').default('balanced')}).strict();
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
 const selected=await readProviderSelection({root});
 const selection=selected?{provider:selected.provider==='jev'?'typesafe-api':'codex-cli',providerRevision:selected.revision}: {};
 if(selected?.provider==='jev'&&(config.marketData!=='order-flow'||decisionMode!=='autonomous'))
  throw Error('JEV_ORDER_FLOW_CONFIG_REQUIRED');
 return {...config,decisionMode,...selection,
  ...(selected?.provider==='jev'?{version:JEV_ENTRY_VERSION,baseUrl:JEV_BASE_URL,model:JEV_MODEL,expectedModel:JEV_MODEL,credentialId:selected.credentialId}:{}),
  enabled:['demo','demo-futures'].includes(mode)&&activation?.enabled===true};
}

const isKevFlow=snapshot=>snapshot.entryPolicyVersion==='kev-order-flow-v1';
function reviewDeadline(snapshot){
 if(!isKevFlow(snapshot))return snapshot.candleBoundary+60000;
 return snapshot.timeframe==='order-flow'&&!Object.hasOwn(snapshot,'candleBoundary')&&snapshot.decisionCadenceVersion==='flow-minute-v1'&&
  snapshot.decisionIntervalMs===60000&&Number.isSafeInteger(snapshot.decisionBoundary)&&snapshot.decisionBoundary>0&&snapshot.decisionBoundary%60000===0
  ?snapshot.decisionBoundary+60000:NaN;
}

function flowEvidenceDeadline(snapshot,candidates,started){
 if(!isKevFlow(snapshot))return null;
 const deadlines=candidates.map(candidate=>{
  const markets=snapshot.markets.filter(m=>m.pair===candidate.pair),proof=markets.length===1?markets[0].orderFlow:null;
  const latest=proof?.books?.at(-1)?.at;
  return proof?.books?.length===3&&Number.isSafeInteger(latest)&&latest>0&&latest<=started?latest+FLOW_MAX_AGE_MS:NaN;
 });
 return deadlines.length&&deadlines.every(Number.isSafeInteger)?Math.min(...deadlines):NaN;
}

// Summaries describe the full sampled tape; the explicitly bounded raw sample
// helps Kev inspect recent prints without claiming this REST sampler is tick HFT.
// Every field is allowlisted, so extra exchange/local fields never reach the CLI.
const compactDecimal=value=>typeof value==='string'&&/^\d+\.\d+$/.test(value)
 ?value.replace(/(\.\d*?[1-9])0+$/,'$1').replace(/\.0+$/,''):value;
function flowEvidence(proof,{coherent=false}={}){
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
   books:coherent?books:books.slice(-2),recentTradeSample:trades.slice(-8).map(t=>({a:t.a,p:compactDecimal(t.p),q:compactDecimal(t.q),T:t.T,m:t.m})),
   rawTradeSampleLimit:8,rawTradeSampleIsComplete:trades.length<=8};
 }catch{return null;}
}

// Rank only candidates that already passed native entry guards. Prefer lower
// execution friction, then stronger persistent aligned flow. This never
// authorizes an order or changes native thresholds.
export function kevFlowShortlistEvidence(market,action,candidate={}){
 try{
  if(Object.hasOwn(candidate,'entrySignalPolicy')){
   const signal=candidate.entrySignal;
   if(!validKevEntrySignalPolicy(candidate.entrySignalPolicy)||signal?.eligible!==true||signal.version!==candidate.entrySignalPolicy.version)return null;
   const share=new Decimal(signal.overall.directionalShare),half=Decimal.min(...signal.halves.map(h=>h.directionalShare)),
    move=new Decimal(signal.quoteResponse.signedMidChangeBps),required=new Decimal(candidate.requiredPriceSpaceBps),
    margin=new Decimal(candidate.netMargin.netMarginAfterQuoteDriftBps);
   if(![share,half,move,required,margin].every(n=>n.isFinite()))return null;
   return {version:'kev-coherent-shortlist-v1',requiredPriceSpaceBps:required.toFixed(),netMarginAfterQuoteDriftBps:margin.toFixed(),
    alignedTakerShare:share.toFixed(),minimumHalfDirectionalShare:half.toFixed(),favorableMidMoveBps:move.toFixed()};
  }
  const metrics=flowEvidence(market?.orderFlow)?.metrics;
  if(!metrics)return null;
  const buy=new Decimal(metrics.takerBuyNotional),sell=new Decimal(metrics.takerSellNotional),total=buy.plus(sell);
  if(total.lte(0))return null;
  const long=action!=='open-short',share=(long?buy:sell).div(total),depth=(metrics.bookImbalances??[])
   .map(value=>new Decimal(value)).filter(value=>value.isFinite()).map(value=>long?value:value.neg());
  if(depth.length<2)return null;
  const persistentBook=Decimal.min(...depth.slice(-2));
  const move=new Decimal(metrics.midPriceChangeBps??0),directionalMove=long?move:move.neg();
  const required=candidate.requiredPriceSpaceBps===undefined?null:new Decimal(candidate.requiredPriceSpaceBps);
  const margin=candidate.netMargin?.netMarginAfterQuoteDriftBps===undefined?null:new Decimal(candidate.netMargin.netMarginAfterQuoteDriftBps);
  if(!share.isFinite()||!persistentBook.isFinite()||!directionalMove.isFinite()||
   (required&&!required.isFinite())||(margin&&!margin.isFinite()))return null;
  return {version:KEV_FLOW_SHORTLIST_VERSION,...(required?{requiredPriceSpaceBps:required.toFixed()}:{}),
   ...(margin?{netMarginAfterQuoteDriftBps:margin.toFixed()}:{}),alignedTakerShare:share.toFixed(),
   persistentBookImbalance:persistentBook.toFixed(),favorableMidMoveBps:directionalMove.toFixed()};
 }catch{return null;}
}
function compareShortlistValue(a,b,field,direction='desc'){
 const left=a.__flowRankEvidence?.[field],right=b.__flowRankEvidence?.[field];
 if(left===undefined&&right===undefined)return 0;
 if(left===undefined)return 1;if(right===undefined)return -1;
 const compared=new Decimal(left).comparedTo(new Decimal(right));
 return direction==='asc'?compared:-compared;
}
function compareShortlist(a,b){
 return compareShortlistValue(a,b,'requiredPriceSpaceBps','asc')||
  compareShortlistValue(a,b,'netMarginAfterQuoteDriftBps')||
  compareShortlistValue(a,b,'alignedTakerShare')||
  compareShortlistValue(a,b,'minimumHalfDirectionalShare')||
  compareShortlistValue(a,b,'persistentBookImbalance')||
  compareShortlistValue(a,b,'favorableMidMoveBps')||a.__flowRankIndex-b.__flowRankIndex;
}

function candidatesFor(reference,snapshot,account,config){
 if(!Number.isSafeInteger(config.maxCandidates)||config.maxCandidates<1)throw Error('KEV_CANDIDATE_POOL_TOO_LARGE');
 const available=(reference.candidates??[]).filter(c=>isEntry(c.action)&&Number(c.stakeUsdt)>0&&
  c.nativeEligible!==false&&
  !(account?.trades??[]).some(t=>t.pair===c.pair));
if(isKevFlow(snapshot)){
  // Balanced always ranks only candidates which already passed every native
  // entry guard. A bounded evidence-based shortlist prevents a large eligible
  // pool from turning into a HOLD/error; Kev still makes the final choice and
  // may HOLD. The rank never authorizes an order or changes a hard threshold.
  const pool=available.map((candidate,index)=>({...candidate,
   __flowRankEvidence:kevFlowShortlistEvidence(snapshot.markets.find(m=>m.pair===candidate.pair),candidate.action,candidate),
   __flowRankIndex:index})).sort(compareShortlist).slice(0,config.maxCandidates);
  const identities=new Set();
  return pool.map((c,i)=>{
   const key=c.pair+'|'+c.action;
   if(identities.has(key))throw Error('KEV_CANDIDATE_DUPLICATE');identities.add(key);
   const market=snapshot.markets.find(m=>m.pair===c.pair);
   if(!market)throw Error('KEV_MARKET_MISSING');
   // Shared narrative assumptions belong once in the prompt, not in every
   // candidate: preserve room for the full public order-flow evidence pool.
   const {basis,feeAssumption,stopScenario,entryQuotePrice,currentExitQuotePrice,holdingHorizon,
    slippageBpsPerSide,fundingReserveBps,...costEconomics}=executableCostEconomics({
    mode:snapshot.mode,action:c.action,market,stopFraction:c.stopFraction,targetFraction:c.targetFraction,maxHoldingSeconds:c.maxHoldingSeconds});
   // The request carries the shared horizon contract once. Keep each
   // candidate's cash-flow values and its existing maxHoldingSeconds intact.
   costEconomics.holdingHorizon={breakEvenFavorableExitQuoteMoveBps:holdingHorizon.breakEvenFavorableExitQuoteMoveBps,
    netUsdtPer100ByFavorableExitMoveBps:holdingHorizon.netUsdtPer100ByFavorableExitMoveBps};
   const netMargin=c.netMargin?{
    version:c.netMargin.version,
    targetNetMarginBps:c.netMargin.targetNetMarginBps,
    quoteDriftReserveBps:c.netMargin.quoteDriftReserveBps,
    netMarginAfterQuoteDriftBps:c.netMargin.netMarginAfterQuoteDriftBps,
    minimumNetMarginBps:c.netMargin.minimumNetMarginBps
   }:null;
   if(!validKevExitPolicy(c.exitPolicy))throw Error('KEV_EXIT_POLICY_MISMATCH');
   const coherent=Object.hasOwn(snapshot,'entrySignalPolicy');
   if(coherent&&(!validKevEntrySignalPolicy(snapshot.entrySignalPolicy)||!validKevEntrySignalPolicy(c.entrySignalPolicy)||
    c.entrySignal?.eligible!==true||c.entrySignal.version!==snapshot.entrySignalPolicy.version))throw Error('KEV_ENTRY_SIGNAL_POLICY_MISMATCH');
   if(!coherent&&Object.hasOwn(c,'entrySignalPolicy'))throw Error('KEV_ENTRY_SIGNAL_POLICY_MISMATCH');
   return {id:'q'+i,pair:c.pair,action:c.action,stopFraction:c.stopFraction,targetFraction:c.targetFraction,
    ...(coherent?{entrySignalPolicyVersion:c.entrySignalPolicy.version,entrySignal:c.entrySignal}:{}),
    exitPolicyVersion:c.exitPolicy.version,maxHoldingSeconds:c.maxHoldingSeconds,__qualifiedCandidateCount:available.length,
     ...(c.__flowRankEvidence?{flowShortlist:c.__flowRankEvidence}:{}),costEconomics,netMargin,
     exitEconomics:candidateExitEconomics({mode:snapshot.mode,action:c.action,market,stopFraction:c.stopFraction,
      targetFraction:c.targetFraction,maxHoldingSeconds:c.maxHoldingSeconds,exitPolicy:c.exitPolicy,proposedEntryNotionalUsdt:c.stakeUsdt})};
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

const KEV_MICROSTRUCTURE_ROLE='你是加密貨幣微結構與訂單流專家 Kev，負責 Demo 環境中的平衡型候選選擇。每個 60 秒窗口，只在系統提供的合格候選有一致、新鮮且扣除成本後仍有足夠空間時選擇一筆；證據不足或矛盾時可選 HOLD。';
// The adapter owns its probability-array output schema. Do not put a second,
// incompatible choice-only format or a fixed list of candidate IDs in state.
// Keep the established balanced decision policy. Request compaction is not
// authority to add a stricter investment thesis or a new decision threshold.
const KEV_MICROSTRUCTURE_CONTEXT="只能選 q 或 HOLD；不得改交易對、方向、價格、數量、槓桿及保護。\n1. q 已通過主機資料、成交／掛單簿方向、成本、容量、報價與風控檢查；合格不代表獲利或必須下單。\n2. 只有方向證據一致、資料仍新鮮、且明示的成本後空間足夠時才選一個。證據不足、矛盾或成本空間不足可 HOLD。\n3. 不得另造數值門檻或重算系統數值。decision probabilities 未校準，不能當成預期報酬或勝率；排序不是獲利預測。\n4. candidateDiagnostics 和 shadowSignalCount 不可選，不得繞過限制。進出報價已含價差，不重複扣除。\n5. targetFraction、targetNetUsdtPer100、netMargin 是固定目標情境，不是預期報酬。比較 holdingHorizon 含費損益兩平位移及 0/10/20/30bps 淨損益情境；不得外推短期觀察為 900 秒預測。不因缺少校準預測而一律 HOLD，不要求未提供的預測。\n6. exitPolicy 適用所有同版候選：原止盈仍有效，另在 300 秒後可收 1 USDT 淨利，600 秒後可收成交本金 10bps 淨利；按 5bps 不利出場滑價後的含費淨利判斷。這是待驗證出場規則，不是勝率證據。停損、追蹤及 900 秒退出仍可能虧損。\n風控、成本、倉位、時限、報價、保護優先，不追求筆數。";
const KEV_MICROSTRUCTURE_INSTRUCTIONS='只從 live q 候選選一個，或選 hold（HOLD）。q 已通過主機硬性檢查但不保證獲利。比較成交與掛單簿方向、資料新鮮度及 holdingHorizon 含費情境；固定目標成本空間不是預期報酬。若證據不足、衝突、過期或成本空間不足，可選 hold。不得為了交易筆數勉強進場、另造門檻、重算數值或把機率當勝率。不得改變交易與保護參數。candidateDiagnostics 與 shadowSignalCount 不可選取或繞過風控。';
const KEV_COHERENT_CONTEXT=KEV_MICROSTRUCTURE_CONTEXT
 .replace('成交／掛單簿方向','同窗成交壓力與雙邊報價反應')
 +'\n7. entrySignalPolicy 是本輪唯一方向共識規則：entrySignal.window 內前後兩半都有同向主動成交，三本訂單簿的買價和賣價同向推進；entrySignal 提供主機計算結果。靜態掛單量不等於未來方向，已驗證的價格推進可與掛單量符號相反，不以其符號獨立否決。orderFlow.metrics 的完整 60 秒成交量只作較長背景，不與共同時間窗混為同一訊號。\n8. 前後兩半的同窗確認已完成，不再要求兩個不同分鐘或更多等待輪次。成交壓力與實際價格反應矛盾、成本不合、資料過期仍可 HOLD；不得強行形成共識。';
const KEV_COHERENT_INSTRUCTIONS='只從合格 q 選一個或 HOLD。依 entrySignal 的同窗前後半成交壓力、買賣報價反應、資料新鮮度與 holdingHorizon 含費情境判斷。靜態掛單量符號及較長 60 秒成交背景不是額外方向否決；不另加兩分鐘確認。固定目標不是預期收益，機率不是勝率。不得另造门檻、勉強下單或修改保護。證據不支持含費機會時仍選 HOLD。';
// Jev is the final selector over the same bounded candidates and hard gates.
// Its prompt policy is versioned; it does not gain authority over execution.
const JEV_ROLE='You select at most one offered Demo candidate under the host-ranked policy. Apply that policy consistently; do not predict prices or guarantee profit.';
const JEV_DECISION_POLICY_VERSION='jev-host-ranked-choice-v2';
const JEV_CONTEXT=[
 "Only keys offered in questions.entry.criteria are selectable. state.candidates is the host priority order: q0 first, then q1 and so on. Only q0 is the default first choice. The existing cost/flow rank is not a profit forecast.",
 "The host has already applied data, eligibility, cost, risk, position and freshness checks. Use supplied computed evidence and existing policies. Do not create thresholds, waiting periods, extra confirmation or research requirements. Execution remains subject to host and native protections.",
 "entrySignalPolicy is the sole direction-consensus rule. Use candidate.entrySignal for its declared common-window direction evidence; both halves already confirm within that window. Full-window orderFlow.metrics and recentTradeSample describe different scopes. rawTradeSampleIsComplete=false means the sample is intentionally partial; do not recompute full-window metrics from it or treat that flag alone as missing required evidence. Static depth-volume sign alone is not a veto.",
 "A concrete blocker must concern this candidate: an explicit failed host condition, a directly conflicting identity/direction/policy, or a genuinely missing or inconsistent required value. Use only declared policy constraints for validity or freshness; do not invent an age limit or an unsupplied current time. candidateDiagnostics and shadowSignalCount describe rejected or unavailable candidates; they cannot be selected and do not block an offered q.",
 "rewardEvidence.expectedEdge=null, holdingHorizon.attainmentProbability=null and forecast=false are intentional limitations, not missing required inputs. General uncertainty, lack of a profit guarantee and uncalibrated probabilities are not blockers. Do not require unavailable forecasts.",
 "targetFraction, netMargin and targetNetUsdtPer100 are fixed target scenarios, not expected profit. costEconomics.holdingHorizon describes fee-inclusive hypothetical movement from the current exit quote. Never extrapolate short observations into a 900-second forecast or rerank candidates by hypothetical target profit.",
 "Respect the separate declared accounting bases of costEconomics and exitEconomics. Entry/exit quotes already include the spread. Each fee, funding reserve and modeled slippage is included once in its stated scenario; never deduct costs twice. A negative unchanged-quote scenario is a cost scenario, not by itself a failed host gate.",
 "The immutable exitPolicy keeps the gross target and allows net harvest after 300 seconds at 1 USDT or after 600 seconds at 10 bps of filled entry notional, after one 5 bps adverse exit allowance. Stop, trailing and the unconditional 900-second exit may lose money. Risk disclosure alone is not a blocker; risk, complete costs, positions, time, quotes and native protection remain mandatory."
].join('\n');
const JEV_INSTRUCTIONS="Walk the offered candidates in host order. Select the first candidate without a concrete supplied-evidence blocker under the context rules. Select hold only when every offered candidate has such a blocker. If none has a blocker, select q0. Do not rerank by hypothetical target profit or invent expected returns. Never alter pair, direction, price, quantity, leverage or protection. Use the existing entry choice response protocol with every offered probability key and confidence; these express selection under this policy, not the chance of a profitable trade. Do not add fields or a second response format.";
const SIZED_EXIT_CONTEXT='Compare candidate exitEconomics at its proposed notional ceiling, including unchanged-quote loss, stop loss and harvest/trail thresholds during maxHoldingSeconds. A smaller eventual fill changes absolute net outcomes and makes fixed-dollar thresholds harder. harvestBelowGrossTarget describes only trigger geometry: false means that harvest cannot precede the higher-priority gross target under these assumptions. It does not predict a price path. Native trailing activates on unreserved fee-inclusive net, gives back the stated amount from the observed peak, and does not guarantee a realized floor. The timer exits even at a net loss; eligibility and profitable target geometry alone do not establish a fee-inclusive opportunity. Preserve the existing HOLD option without requiring an unavailable calibrated forecast.';
const JEV_SIZED_EXIT_CONTEXT="exitEconomics uses the proposed notional ceiling, not an executed size; native exits use actual filled notional and signed booked funding. A smaller fill changes absolute net outcomes. Respect the supplied reserve basis and exit precedence: trail uses unreserved net and harvest uses net after one adverse exit reserve. harvestBelowGrossTarget=false describes trigger geometry, not a forecast or an automatic rejection. Stops, trailing, gross target and the unconditional holding cap retain precedence; they do not guarantee realized profit.";

function publicCandidateDiagnostics(diagnostics){
 if(!diagnostics)return null;
 const {version,total,eligible,blocked,hardBlocked,softBlocked}=diagnostics;
 return {version,total,eligible,blocked,hardBlocked,softBlocked,
  blockers:(diagnostics.blockers??[]).map(({reason,count,class:kind})=>({reason,count,class:kind}))};
}

function requestFor(snapshot,candidates,config,reference){
 const coherent=Object.hasOwn(snapshot,'entrySignalPolicy');
 const publicCandidates=candidates.map(({__qualifiedCandidateCount,...candidate})=>candidate);
 const common={mode:snapshot.mode,snapshotId:snapshot.id,observedAt:snapshot.completedAt??snapshot.createdAt,
  decisionMode:config.decisionMode,cadence:snapshot.decisionCadenceVersion??'flow-minute-v1',
  decisionIntervalMs:snapshot.decisionIntervalMs??60000,decisionStyle:'balanced',candidates:publicCandidates,
  ...(isJevConfig(config)?{reviewerDecisionPolicyVersion:JEV_DECISION_POLICY_VERSION}:{}),
  ...(decisionProviderEvidence(config)?{decisionProvider:decisionProviderEvidence(config)}:{}),
  // Rejected pairs cannot be selected. Keep the complete diagnostics in the
  // sealed local review, while transmitting only their reason/count summary.
  // Otherwise a single eligible pair also pays to classify every rejected
  // pair and its opposite-side shadow, consuming the same short CLI deadline.
  candidateDiagnostics:isKevFlow(snapshot)?publicCandidateDiagnostics(reference?.metadata?.candidateDiagnostics):reference?.metadata?.candidateDiagnostics??null,
  ...(isKevFlow(snapshot)?{shadowSignalCount:reference?.metadata?.shadowCandidates?.length??0}:{shadowSignals:(reference?.metadata?.shadowCandidates??[]).map(c=>({pair:c.pair,action:c.requestedAction,reason:c.shadowReason,
   tapeDirection:c.flowDiagnostics?.tapeDirection??null,bookDirection:c.flowDiagnostics?.bookDirection??null,
   takerShare:c.flowDiagnostics?.takerShare??null,bookImbalances:c.flowDiagnostics?.bookImbalances??null}))})};
 if(isKevFlow(snapshot))return {model:config.model,state:{...common,
  marketData:'order-flow',entryPolicyVersion:snapshot.entryPolicyVersion,requestVersion:coherent?KEV_FLOW_REQUEST_VERSION:'kev-flow-request-v4',
  ...(coherent?{entrySignalPolicy:{...snapshot.entrySignalPolicy}}:{}),
  exitPolicy:{...KEV_NET_HARVEST_POLICY},
   profitProtection:{...DEMO_PROFIT_PROTECTION},
   exitEconomicsEvidence:{version:KEV_SIZED_EXIT_EVIDENCE_VERSION,
    notionalBasis:'Proposed entry-notional ceiling, not a fill; final sizing may decrease. Native exits use actual filled amount times open rate.',
    accounting:'Native filled-notional fee convention; each fee once. Both scenarios include adverse reserved funding, not known booked funding; native exits use actual signed booked funding. No extra spread charge.',
    exitReserve:'netUsdtAfterExitReserve models one adverse exit leg; trail thresholds use native unreserved net, harvest thresholds use reserved net.',
    precedence:'Persisted trail or stop, gross target, unconditional holding cap, then harvest. Giveback is measured from the observed net peak.',
    limitation:'Scenarios are not forecasts or full-quantity executable fills. Stop-trigger scenarios exclude the additional spot stop-limit stress reserve and are not loss bounds. Actual fees, funding, depth and fills can differ.'},
  decisionBoundary:snapshot.decisionBoundary,expiresAt:new Date(reviewDeadline(snapshot)).toISOString(),
  rewardEvidence:{version:'kev-reward-evidence-v1',plannedTargetSource:'fixed_exit_geometry',
   plannedMarginFields:['netMargin','costEconomics.targetNetUsdtPer100'],expectedEdge:null,
   holdingHorizon:{version:'kev-cost-horizon-v1',maxHoldingSecondsSource:'candidate.maxHoldingSeconds',attainmentProbability:null,forecast:false},
   scenarioBasis:'100 USDT entry; move from current exit bid (long) / ask (short); fees, slippage, funding once; buffer is not expense',
   horizonMeaning:'Holding limit, not forecast or guaranteed timer profit'},
  markets:[...new Set(candidates.map(c=>c.pair))].map(pair=>{
   const m=snapshot.markets.find(m=>m.pair===pair);
   return {pair,bid:m.bid,ask:m.ask,spreadBps:m.spreadBps,quoteObservedAt:m.fetchedAt,
    costs:m.entryCost?{estimatedRoundTripCostBps:m.entryCost.estimatedRoundTripCostBps,
     requiredPriceSpaceBps:m.entryCost.requiredPriceSpaceBps,roundTripFeeBps:m.entryCost.roundTripFeeBps,
     slippageBpsPerSide:m.entryCost.slippageBpsPerSide,fundingReserveBps:m.entryCost.fundingReserveBps,
     observedAt:m.entryCost.observedAt}:undefined,
    orderFlow:flowEvidence(m.orderFlow,{coherent})};
  }),
  role:isJevConfig(config)?JEV_ROLE:KEV_MICROSTRUCTURE_ROLE,
   context:(isJevConfig(config)?JEV_CONTEXT:coherent?KEV_COHERENT_CONTEXT:KEV_MICROSTRUCTURE_CONTEXT)+'\n'+(isJevConfig(config)?JEV_SIZED_EXIT_CONTEXT:SIZED_EXIT_CONTEXT),
  highFrequency:true},questions:{entry:{type:'choice',
   instructions:isJevConfig(config)?JEV_INSTRUCTIONS:coherent?KEV_COHERENT_INSTRUCTIONS:KEV_MICROSTRUCTURE_INSTRUCTIONS,
    criteria:Object.fromEntries([...candidates.map(c=>[c.id,isJevConfig(config)?
     c.id+' / '+c.pair+' / '+c.action+(c.id==='q0'?
      '; first host-ranked candidate. Select unless it has a concrete supplied-evidence blocker.':
      '; candidate in the supplied host order. Select only if every preceding candidate is blocked and this candidate is not.'):
     c.pair+' / '+c.action+'; supplied evidence supports a fee-inclusive opportunity within its holding limit.']),
     ['hold',isJevConfig(config)?
      'Only when every offered q has an explicit supplied-evidence blocker; general uncertainty or a profit guarantee is not a blocker.':
      'No offered candidate has a sufficiently supported fee-inclusive opportunity in this window, including when host checks pass.']])}}};
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

function freshnessTimestamp(value){
 if(typeof value==='number'&&Number.isFinite(value))return value>1e12?value:value>1e9?value*1000:null;
 const parsed=Date.parse(value??'');return Number.isFinite(parsed)?parsed:null;
}
function ageAt(value,at){const sample=freshnessTimestamp(value);return sample===null?null:at-sample;}
function kevDecisionDiagnostics({snapshot,reference,candidates=[],requestBudget=null,choice=null,holdReason=null,at=Date.now()}){
 const pool=reference?.metadata?.candidateDiagnostics??null;
 const pairs=new Set([...(candidates??[]).map(c=>c.pair),...(pool?.candidates??[]).map(c=>c.pair)].filter(Boolean));
 const dataFreshness=[...(snapshot?.markets??[])].filter(m=>pairs.has(m.pair)).map(m=>{
  const books=m.orderFlow?.books??[],trades=m.orderFlow?.trades??[],latestBook=books.reduce((best,row)=>
   freshnessTimestamp(row.at)>(freshnessTimestamp(best?.at)??-Infinity)?row:best,null),latestTrade=trades.reduce((best,row)=>
   freshnessTimestamp(row.T)>(freshnessTimestamp(best?.T)??-Infinity)?row:best,null);
  const latestTradeMs=latestTrade?freshnessTimestamp(latestTrade.T):null;
  return {pair:m.pair,quoteObservedAt:m.fetchedAt??null,quoteAgeMs:ageAt(m.fetchedAt,at),
   orderFlowWindowStartAt:m.orderFlow?.startTime?new Date(m.orderFlow.startTime).toISOString():null,
   orderFlowWindowEndAt:m.orderFlow?.endTime?new Date(m.orderFlow.endTime).toISOString():null,
   latestBookAt:latestBook?.at??null,latestBookAgeMs:ageAt(latestBook?.at,at),
   latestTradeAt:latestTradeMs===null?null:new Date(latestTradeMs).toISOString(),
   latestTradeAgeMs:ageAt(latestTrade?.T,at)};
 });
 const chosen=/^q\d+$/.test(choice??'')?candidates[Number(choice.slice(1))]??null:null;
 return {version:'kev-decision-audit-v1',decisionStyle:'balanced',candidatePool:{
  total:pool?.total??(reference?.candidates??[]).length,eligibleBeforeKev:pool?.eligible??(reference?.candidates??[]).filter(c=>c.nativeEligible!==false&&c.action!=='hold').length,
  hardBlocked:pool?.hardBlocked??null,blockers:(pool?.blockers??[]).slice(0,12)},
  qualifiedCandidateCount:candidates[0]?.__qualifiedCandidateCount??candidates.length,presentedCandidateCount:candidates.length,
  ...(requestBudget?{requestBudget}:{}),
  kevChoice:choice,selectedPair:chosen?.pair??null,selectedAction:chosen?.action??null,
  kevSelectedQualified:Boolean(chosen&&chosen.nativeEligible!==false),holdReason:holdReason??(choice==='hold'?'KEV_SELECTED_HOLD':null),
  dataFreshness};
}

function seal(value){return {...value,proofSha256:kevDigest(value)};}
function unseal(review){const {proofSha256,...body}=review;return proofSha256===kevDigest(body);}
const reasonForError=e=>e?.name==='TimeoutError'||e?.name==='AbortError'?'KEV_TIMEOUT_OR_ABORTED':
 /^(?:KEV|JEV|DECISION_PROVIDER)_[A-Z_]+$/.test(e?.message??'')?e.message:'KEV_SERVICE_UNAVAILABLE';

export async function reviewKevEntries({reference,snapshot,policy,account,config,signal,fetchImpl=fetch,now=Date.now,credentialFn=loadJevCredential}){
 const started=now(),base={version:config.version??KEV_ENTRY_VERSION,enabled:config.enabled,mode:policy.mode,snapshotId:snapshot.id,
  ...(config.providerRevision?{provider:reviewerProvider(config),providerRevision:config.providerRevision}:{}),
  snapshotSha256:kevDigest(snapshot),configSha256:kevDigest(config),startedAt:new Date(started).toISOString(),
  decisionMode:config.decisionMode,invoked:false,requestAttempted:false,approvedPairs:[],decisions:[],
  candidateDiagnostics:reference.metadata?.candidateDiagnostics??null,
  decisionDiagnostics:kevDecisionDiagnostics({snapshot,reference,at:started})};
 if(!config.enabled)return seal({...base,status:'disabled',reason:'KEV_DISABLED'});
 if(!['demo','demo-futures'].includes(policy.mode)||snapshot.mode!==policy.mode)throw Error('KEV_DEMO_ONLY');
 if(config.providerRevision&&(snapshot.kevEntry?.provider!==reviewerProvider(config)||
  snapshot.kevEntry.providerRevision!==config.providerRevision||snapshot.kevEntry.model!==config.expectedModel||
  snapshot.kevEntry.version!==config.version))
  return seal({...base,status:'hold',reason:'DECISION_PROVIDER_SNAPSHOT_MISMATCH'});
 if(isJevConfig(config)&&(!config.providerRevision||!isKevFlow(snapshot)||!validKevEntrySignalPolicy(snapshot.entrySignalPolicy)||
  config.decisionMode!=='autonomous'||config.marketData!=='order-flow'))
  return seal({...base,status:'hold',reason:'JEV_ORDER_FLOW_CONFIG_REQUIRED'});
 if(config.decisionMode!=='autonomous'&&!isEntry(reference.proposal.action))
  return seal({...base,status:'not_requested',reason:'KEV_NO_ELIGIBLE_ENTRY'});
 if(isKevFlow(snapshot)&&(config.decisionMode!=='autonomous'||config.marketData!=='order-flow'))
  return seal({...base,status:'hold',reason:'KEV_ORDER_FLOW_CONFIG_MISMATCH'});
 let candidates;
 try{candidates=candidatesFor(reference,snapshot,account,config);}
 catch(error){const reason=reasonForError(error);base.decisionDiagnostics=kevDecisionDiagnostics({snapshot,reference,holdReason:reason,at:started});return seal({...base,status:'hold',reason});}
 base.decisionDiagnostics=kevDecisionDiagnostics({snapshot,reference,candidates,at:started});
 if(!candidates.length){base.decisionDiagnostics=kevDecisionDiagnostics({snapshot,reference,candidates,holdReason:'KEV_NO_ELIGIBLE_ENTRY',at:started});return seal({...base,status:'not_requested',reason:'KEV_NO_ELIGIBLE_ENTRY'});}
 const deadline=reviewDeadline(snapshot);
 if(!Number.isSafeInteger(deadline)||(isKevFlow(snapshot)&&started<snapshot.decisionBoundary)||signal?.aborted)
  {base.decisionDiagnostics=kevDecisionDiagnostics({snapshot,reference,candidates,holdReason:'KEV_INSUFFICIENT_ENTRY_TIME',at:started});return seal({...base,status:'hold',reason:'KEV_INSUFFICIENT_ENTRY_TIME'});}
 // Keep a prefix of the existing cost/flow rank. Never truncate an offered
 // candidate's evidence or change its identity to fit the transport bound.
 // Unused markets disappear with their final candidate, including Futures
 // markets shared by two directions. The full pool remains in the local run.
 const qualifiedBeforeBudget=candidates.length;
 let request=requestFor(snapshot,candidates,config,reference),payload=JSON.stringify(request),payloadBytes=Buffer.byteLength(payload);
 while(isKevFlow(snapshot)&&payloadBytes>32768&&candidates.length>1){
  candidates=candidates.slice(0,-1);
  request=requestFor(snapshot,candidates,config,reference);
  payload=JSON.stringify(request);payloadBytes=Buffer.byteLength(payload);
 }
 const requestBudget={version:'kev-request-byte-budget-v1',maxPayloadBytes:32768,qualifiedBeforeBudget,
  presentedCandidateCount:candidates.length,omittedCandidateCount:qualifiedBeforeBudget-candidates.length,
  omissionReason:qualifiedBeforeBudget>candidates.length?'KEV_REQUEST_BYTE_BUDGET':null};
 const diagnostic=(extra={})=>kevDecisionDiagnostics({snapshot,reference,candidates,requestBudget,at:started,...extra});
 base.decisionDiagnostics=diagnostic();
 base.requestMetrics={payloadBytes,...requestBudget};
 if(payloadBytes>32768){base.decisionDiagnostics=diagnostic({holdReason:'KEV_REQUEST_TOO_LARGE'});return seal({...base,status:'hold',reason:'KEV_REQUEST_TOO_LARGE'});}
 // Time authority belongs only to the exact offered pool and original raw
 // timestamps. Byte pruning never refreshes proof time or extends the minute.
 const flowDeadline=flowEvidenceDeadline(snapshot,candidates,started),effectiveDeadline=Math.min(deadline,flowDeadline??Infinity);
 const timeoutMs=Math.min(config.timeoutMs,effectiveDeadline-started-config.executionReserveMs-1000);
 if(isKevFlow(snapshot)&&(!Number.isSafeInteger(flowDeadline)||request.state.markets.some(m=>!m.orderFlow)))
  {base.decisionDiagnostics=diagnostic({holdReason:'KEV_ORDER_FLOW_EVIDENCE_MISSING'});return seal({...base,status:'hold',reason:'KEV_ORDER_FLOW_EVIDENCE_MISSING'});}
 if(timeoutMs<2000)
  {base.decisionDiagnostics=diagnostic({holdReason:'KEV_INSUFFICIENT_ENTRY_TIME'});return seal({...base,status:'hold',reason:'KEV_INSUFFICIENT_ENTRY_TIME'});}
 // Failed/expired calls need their actual request and time budget too. A
 // timeout is an unknown reviewer result, not a discretionary Kev HOLD.
 base.request=request;
 base.requestMetrics={...base.requestMetrics,timeoutMs,configuredTimeoutMs:config.timeoutMs,
  executionReserveMs:config.executionReserveMs,deadlineAt:new Date(deadline).toISOString(),
  ...(isKevFlow(snapshot)?{flowEvidenceDeadlineAt:new Date(flowDeadline).toISOString(),
   effectiveDeadlineAt:new Date(effectiveDeadline).toISOString()}: {})};
 try{
  const timeout=AbortSignal.timeout(timeoutMs+1000),abort=signal?AbortSignal.any([timeout,signal]):timeout;
  let result;
  if(isJevConfig(config)){
   const key=await credentialFn({credentialId:config.credentialId});
   const remaining=timeoutMs-(now()-started);
   if(remaining<1||abort.aborted)throw Error('JEV_TIMEOUT');
   base.requestAttempted=true;base.invoked=null;
   result=await callJev({request,key,timeoutMs:remaining,signal:abort,fetchImpl,now});
  }else{
   base.requestAttempted=true;base.invoked=null;
   const response=await fetchImpl(config.baseUrl+'/v1/systemone',{method:'POST',redirect:'error',signal:abort,
    headers:{'Content-Type':'application/json','X-Kev-Timeout-Ms':String(timeoutMs)},body:payload});
   if(!response.ok)throw Error(response.status===429?'KEV_BUSY_OR_LIMIT':response.status===504?'KEV_TIMEOUT':'KEV_HTTP_ERROR');
   const text=await response.text();if(text.length>65536)throw Error('KEV_RESPONSE_TOO_LARGE');
   result=JSON.parse(text);
  }
  const backend=result.backend;
  if(!reviewerBackendMatches(result,config,kevDigest))throw Error('KEV_BACKEND_MISMATCH');
  base.invoked=true;
  const completed=now(),remote=Date.parse(result.created_at);
  if(!Number.isFinite(remote)||remote<started-2000||remote>completed+2000||completed<started||
   completed-started>timeoutMs+1000||completed>=effectiveDeadline-config.executionReserveMs||signal?.aborted)throw Error('KEV_RESPONSE_STALE');
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
  base.decisionDiagnostics=diagnostic({choice:selection?.choice??null,at:completed});
  return seal({...base,status:'reviewed',reason:null,completedAt:new Date(completed).toISOString(),
   // Match the route's native deadline, independently checked again
   // after RPC queuing at callback, order context and the exchange wire.
   expiresAt:new Date(deadline).toISOString(),
   actualModel:backend.actual_model,requestId:result.request_id,usage:result.usage,latencyMs:completed-started,
   request,response:result,decisions,approvedPairs:decisions.filter(d=>d.approved).map(d=>d.pair),...(selection?{selection}: {})});
 }catch(error){const reason=reasonForError(error),completed=now();base.decisionDiagnostics=diagnostic({holdReason:reason,at:completed});return seal({...base,status:'hold',reason,completedAt:new Date(completed).toISOString()});}
}

export function kevEntryRejection({review,snapshot,proposal,config,now=Date.now()}){
 if(!config.enabled||!isEntry(proposal.action))return null;
 if(!review||review.enabled!==true||review.version!==(config.version??KEV_ENTRY_VERSION)||!unseal(review)||
  review.mode!==snapshot.mode||review.snapshotId!==snapshot.id||review.snapshotSha256!==kevDigest(snapshot)||
  review.configSha256!==kevDigest(config)||
  (config.providerRevision&&(review.provider!==reviewerProvider(config)||review.providerRevision!==config.providerRevision)))
  return 'KEV_APPROVAL_MISSING_OR_MISMATCH';
 if(review.status!=='reviewed')return review.reason??'KEV_NOT_APPROVED';
 const completed=Date.parse(review.completedAt),expiry=Date.parse(review.expiresAt);
 if(!Number.isFinite(completed)||!Number.isFinite(expiry)||now<completed||now>=expiry||
  expiry!==reviewDeadline(snapshot)||expiry>completed+config.approvalTtlMs)return 'KEV_APPROVAL_EXPIRED';
 const answer=review.decisions.filter(d=>d.pair===proposal.pair&&d.action===proposal.action);
 if(answer.length!==1||!answer[0].approved)return 'KEV_ENTRY_VETO';
 if(isKevFlow(snapshot))try{reviewedKevExitPolicy(review,proposal.pair,proposal.action);}catch{return 'KEV_EXIT_POLICY_MISMATCH';}
 if(isKevFlow(snapshot))try{reviewedKevEntrySignalPolicy(review,snapshot,proposal.pair,proposal.action);}catch{return 'KEV_ENTRY_SIGNAL_POLICY_MISMATCH';}
 return null;
}

export function kevBlockedPairs(review,policy){
 return review?.enabled?policy.pairs.filter(pair=>!review.approvedPairs?.includes(pair)):[];
}

export function kevEntryReceipt(review,pair,action){
 if(!review?.enabled||review.status!=='reviewed')return null;
 const decisions=review.decisions.filter(d=>d.pair===pair&&(!action||d.action===action));
 const decision=decisions.find(d=>d.approved)??decisions[0];
 return {version:review.version,decisionMode:review.decisionMode??'approval',provider:review.provider??'codex-cli',model:review.actualModel,requestId:review.requestId,
  ...(review.providerRevision?{providerRevision:review.providerRevision}:{}),
  snapshotId:review.snapshotId,snapshotSha256:review.snapshotSha256,configSha256:review.configSha256,proofSha256:review.proofSha256,
  completedAt:review.completedAt,expiresAt:review.expiresAt,
  decision,selection:review.selection??null,probabilitiesCalibrated:false};
}
