// Host-owned active AI contract; historical positions keep their entry-time plans.
import {DEMO_PARAMETERS,DEMO_RULE_VERSION,DEMO_RISK_BUDGET_USDT} from './demo-rules.mjs';
import {MODEL_ENTRY_POLICY} from './model-momentum.mjs';
import {demoRiskPolicy} from './demo-risk.mjs';
import {ADAPTIVE_FLOW_VERSION,ADAPTIVE_FLOW_BOUNDS} from './adaptive-parameters.mjs';
import {FLOW_DECISION_CADENCE_VERSION,FLOW_DECISION_INTERVAL_MS,AI_ENTRY_CADENCE_VERSION,AI_ENTRY_INTERVAL_MS,AI_ENTRY_WINDOW_MS} from './entry-timing.mjs';
import {KEV_FLOW_POLICY,KEV_NATIVE_VERSION,KEV_FLOW_PARAMETERS} from './kev-flow.mjs';

export function demoStrategyContract(policy,snapshot={}){
 if(!['demo','demo-futures'].includes(policy.mode))throw Error('DEMO_CONTRACT_MODE_REQUIRED');
 if(snapshot.entryPolicyVersion===KEV_FLOW_POLICY||policy.entryPolicyVersion===KEV_FLOW_POLICY)return kevFlowContract(policy,snapshot);
 return {
  version:2,ruleVersion:DEMO_RULE_VERSION,entryPolicyVersion:MODEL_ENTRY_POLICY,mode:policy.mode,
  directionCapabilities:policy.mode==='demo'
   ?{long:'buy',short:null,closeLong:'sell',closeShort:null,shortStatus:'unavailable_on_binance_spot_demo',shortReason:'SPOT_SHORT_REQUIRES_MARGIN'}
   :{long:'open-long',short:'open-short',closeLong:'close-long',closeShort:'close-short',shortStatus:'available_on_usdt_perpetual_demo'},
  decisionEngine:'rules',analystRole:'review_only',
  kevEntryReview:{version:'kev-codex-entry-v1',enabled:snapshot.kevEntry?.enabled===true,
   activation:'Per-mode local/kev-entry.json; activation and config are included in the entry-time source fingerprint.',
   model:snapshot.kevEntry?.model??null,decisionMode:snapshot.kevEntry?.decisionMode??'approval',
   role:'approve/veto existing native-eligible candidates or autonomously select one candidate when configured',
   cadence:'One request per snapshot only when an eligible entry exists; no request for HOLD or exits.',
   failure:'Missing, declined, expired, mismatched or unavailable review blocks new entries. Native exits never wait for this service.',
   limits:'No direction reversal, size/stop changes, guard bypass, or profitability guarantee. Probabilities are uncalibrated model estimates.'},
  objective:'Evaluate actual fee-adjusted Demo net PnL, drawdown and calendar-month results. Entry count and forecast amplitude do not establish profitability.',
  executionQuality:null,
  orderFlow:{version:'sampled-demo-flow-v1',sampling:'Continuous 10-second REST depth and 60-second aggregate-trade samples; not event OFI.',
   usedForEntryDecision:false,usedForNewAiExits:false,
   entry:'The pinned model direction selects the side. Sampled order flow remains research evidence.',
   degradation:'Missing flow does not veto AI direction; quote, cost, clock, risk and model evidence remain mandatory.',
   lossCooldown:{version:'flow-loss-cooldown-v1',durationMs:600000,rule:'A closed negative Demo fill blocks only the same pair for ten minutes, including AI entries.'}},
  adaptiveParameters:{version:ADAPTIVE_FLOW_VERSION,bounds:ADAPTIVE_FLOW_BOUNDS,activeForNewAiEntries:false,
   method:'Historical flow plans retain their adaptive risk. Current AI entries use the fixed maximum 1 USDT stress-risk budget.'},
  volatilityResponse:{version:'closed5m-volatility-v1',activeForNewAiEntries:false,
   method:'The 35/70-minute adaptive flow multiplier is not applied by AI entries. Closed 15m ATR still sets stop and target distances.'},
  decisionCadence:{version:FLOW_DECISION_CADENCE_VERSION,intervalMs:FLOW_DECISION_INTERVAL_MS,
   entryVersion:AI_ENTRY_CADENCE_VERSION,entryIntervalMs:AI_ENTRY_INTERVAL_MS,entryWindowMs:AI_ENTRY_WINDOW_MS,
   candleTimeframe:'5m',atrTimeframe:'15m',
   rule:'Observe every minute. Evaluate AI entries only in the first minute after a complete 5m candle using its exact snapshot and fresh prediction. Other minutes record MODEL_NEXT_CANDLE_WAIT without waiting for a nonexistent forecast.'},
  parameters:DEMO_PARAMETERS,volumeExperiment:null,
  execution:{version:'per-pair-cycle-v1',policy:'Process distinct eligible pairs serially within one immutable snapshot; recheck capacity and guards. Unknown submission stops the batch. A submission is not a fill.'},
  entrySignalEngine:'kronos_ai',
  model:{checkpoint:'NeoQuasar/Kronos-small',role:'entry_direction_authority',usedForEntryDecision:true,
   weights:'Existing pinned weights and three-step forecast; the producer never submits orders.',
   quality:'Price-MAE underperformance is diagnostic; unavailable or stale validated evidence prevents entry.'},
  modelAssist:{version:'kronos-flow-v1',enabled:true,scope:policy.mode==='demo'?'spot and long-only entry direction':'futures entry direction',
   role:'entry direction authority',rule:'Three forecast closes must remain strictly on one side of the origin close.',
   authority:'Quotes, full costs, ATR geometry, risk, time and native protection remain mandatory.'},
  entries:{actions:policy.mode==='demo'?['buy']:['open-long','open-short'],
   direction:'The pinned three-step forecast selects the side. Spot is long-only; bearish forecasts are unavailable as SPOT_SHORT_REQUIRES_MARGIN. Futures permits either side.',
   momentum:'The pinned model direction is authoritative; K-line momentum, SMA, trend, pullback and order flow are diagnostic only.',
   averages:'No moving-average entry gate.',volume:'No candle-volume or taker-flow gate. The retired volume experiment is not supported for new entries.',breakout:'No breakout or pullback gate.',
   confirmation:'Native guard v10 validates path, snapshot/tag, clock and first-minute deadline, quote, ATR and costs at callback, context and wire. AI plans use the model candle deadline; historical flow plans retain their cadence.',
   costs:'Full estimated round-trip cost plus 30bps buffer must fit planned 2x closed-15m ATR target space and forecast amplitude versus executable quote. ATR fractions use origin close. Forecast surplus must be strictly positive.',
   selection:'Rank by forecast surplus above required cost space, then pair as deterministic tie-break. This is not calibrated expected profit.',
   netRewardRiskGate:false},
  sizing:{riskBudgetUsdt:DEMO_RISK_BUDGET_USDT,maxStakeUsdt:policy.maxStakeUsdt,riskPolicy:demoRiskPolicy(policy.mode),
   method:'Divide the fixed maximum 1 USDT stress-risk budget by stopFraction + estimatedRoundTripCostBps/10000 + native reserve; cap by exposure/stake and reject undersized orders. Spot reserves 50bps for its stop-limit interval. This is not a guaranteed loss ceiling.',
   leverage:1,maxEntriesPerDay:policy.maxEntriesPerDay===0?'unlimited':policy.maxEntriesPerDay},
  exits:{owner:'native_engine',nativeVersion:'demo-rule-exits-v12',stopPriceVersion:'stable-unarmed-stop-v1',
   stopPrecision:'Retain tighter existing stops without conversion drift; never widen them.',
   plan:'Each position retains its original stop, target, time limit and profit protection. Existing v11 positions retain their original plan. New AI plans use 2 ATR target, 1 ATR stop capped at 2%, net-profit trailing and four-hour maximum hold. Historical flow exits remain attached only to their recorded plans.',
   accounting:'Trailing uses recorded net-profit peak and fees/funding. Slippage, gaps and stop-limit non-fills may exceed planned loss. Actual fills alone establish realized PnL.'}
 };
}
function kevFlowContract(policy,snapshot){
 const legacy=demoStrategyContract({...policy,entryPolicyVersion:undefined}),model=snapshot.kevEntry?.model??null;
 return {...legacy,version:3,ruleVersion:KEV_FLOW_POLICY,entryPolicyVersion:KEV_FLOW_POLICY,entrySignalEngine:'kev_order_flow',
  kevEntryReview:{...legacy.kevEntryReview,enabled:snapshot.kevEntry?.enabled===true,model,decisionMode:'autonomous',
   role:'Choose one verified pair and direction from fresh order-book and taker-trade observations, or HOLD.',
   cadence:'At most one bounded request per fresh minute with cost/risk-eligible candidates; no request for exits.',
   limits:'Spot buy or HOLD; futures long, short or HOLD. No order submission, size/stop changes, guard bypass or profit guarantee.'},
  orderFlow:{...legacy.orderFlow,usedForEntryDecision:true,
   entry:'Kev directly selects the pair and side from fresh sampled depth, aggressive trades and short-term price changes.',
   degradation:'Missing, malformed or stale order flow blocks the affected candidate. No candle or model-forecast fallback.'},
  adaptiveParameters:{...legacy.adaptiveParameters,method:'Fixed maximum 1 USDT estimated stress-risk budget; historical plans retain their recorded sizing.'},
  volatilityResponse:{version:'kev-flow-fixed-exits-v1',activeForNewAiEntries:false,method:'New entries use fixed 0.5% stop and 1.5% target; no candles or ATR are collected for this entry route.'},
  decisionCadence:{version:FLOW_DECISION_CADENCE_VERSION,intervalMs:FLOW_DECISION_INTERVAL_MS,
   entryVersion:KEV_FLOW_POLICY,entryIntervalMs:FLOW_DECISION_INTERVAL_MS,entryWindowMs:FLOW_DECISION_INTERVAL_MS,
   candleTimeframe:null,atrTimeframe:null,rule:'Fresh minute decisions expire at the next minute. Every minute is eligible without waiting for a K-line close. Sampling is REST, not subsecond exchange execution.'},
  parameters:KEV_FLOW_PARAMETERS,
  execution:{version:'per-pair-cycle-v1',policy:'Only the single Kev-approved pair/direction can enter, after independent risk and native protection checks. Submission is not a fill.'},
  model:{checkpoint:null,model,role:'kev_order_flow_entry_authority',usedForEntryDecision:true,
   weights:'Kev-format decision service uses Codex CLI; no local Kev weights or Kronos prediction is required.',
   quality:'Missing, malformed, tied, expired or unavailable decision means HOLD. Choice probabilities are uncalibrated.'},
  modelAssist:{version:'kronos-flow-v1',enabled:false,scope:'independent research only',role:'no entry authority',rule:'Kronos predictions are not requested by this entry route.',authority:'No candle or forecast gate.'},
  entries:{actions:policy.mode==='demo'?['buy']:['open-long','open-short'],
   direction:'Kev chooses the pair and direction, or HOLD, from all fresh candidates that pass data, cost, capacity and risk checks.',
   momentum:'Short-term raw-trade price changes are decision context; no candle momentum gate.',averages:'No moving-average entry gate.',
   volume:'Raw taker trades and order-book depth are model context; no deterministic directional flow threshold.',breakout:'No breakout or pullback gate.',
   confirmation:KEV_NATIVE_VERSION+' verifies the stored Kev approval, snapshot, data proof, clock, minute expiry, quote, fixed exits, costs and risk at callback, context and wire.',
   costs:'The fixed 150bps target must cover complete round-trip cost plus 30bps buffer; planned net reward must exceed planned stop risk. Target space is not a forecast.',
   selection:'Kev autonomously chooses one pair and side or HOLD; no Kronos candidate filtering or deterministic directional ranking.',netRewardRiskGate:true},
  exits:{...legacy.exits,plan:'Each existing position retains its original plan. New Kev plans use a fixed 0.5% stop, 1.5% target, native net-profit trailing and 15-minute maximum hold. Native exits never wait for Kev.'}};
}
export function renderDemoStrategyContract(contract){
 if(contract.entryPolicyVersion===KEV_FLOW_POLICY)return ['# Host-generated Demo strategy contract',
  'Kev 直接使用即時訂單簿、主動買賣成交與短期價格變化選交易對、方向或 HOLD。現貨只做多；合約可做多或做空。',
  '每分鐘重新判斷，不收集 K 線或 ATR，不等待 Kronos 預測。一次候選合併成一次 CLI 請求；過期、格式錯誤或服務不可用即 HOLD。',
  '資料、報價、完整成本、倉位、風險及原生保護仍須通過。新倉固定停損 0.5%、停利 1.5%、最長持倉 15 分鐘，估算風險預算最高 1 USDT；此預算不是最大損失保證。',
  '原有持倉保留原計畫，停損與平倉不等待 Kev。以實際成交和費後損益評估，不以模型機率、目標價格或交易次數當作獲利證據。',
  JSON.stringify(contract)].join('\n\n');
 return ['# Host-generated Demo strategy contract',
  'Demo 進場由已收盤 AI 三步預測選擇方向；三步必須同在原始收盤價的一側。AI 同意後，成本、報價、ATR、倉位、期限及原生停損仍須通過。現貨只做多，空方假設為 HOLD/SPOT_SHORT_REQUIRES_MARGIN；合約可做多或做空。',
  '每分鐘更新行情、倉位及風控；AI 新進場只在完整五分鐘 K 線後的首分鐘評估。其他分鐘等待下一根 K 線，不等待不存在的新預測，也不延用過期訊號。',
  '若已啟用 Kev／Codex 進場覆核，只將本輪合格候選合併送交一次 CLI；自主模式可選一個既有候選或 HOLD，批准僅適用同一快照、幣對、方向及短效期限。拒絕、逾時、格式錯誤或服務離線均不進場。原生平倉與停損不等待此覆核。',
  '訂單流、K 線動能、均線、成交量與舊 volume experiment 不作 AI 進場門檻。新 AI 計畫沒有訂單流退出或 flow 動態縮倉；舊倉仍按各自原計畫退出。',
  '現行 AI 使用最高 1 USDT 估算風險預算，含完整成本與現貨原生停損限價保留額，另受倉位及曝險限制。虧損平倉後同幣對冷卻十分鐘。估算預算不是最大損失保證。',
  '2 倍已完成 15 分鐘 ATR 目標與模型相對可成交報價的幅度，都必須覆蓋完整成本及 30bps 緩衝。此路徑沒有額外的 flow 淨報酬風險比門檻；ATR 空間與預測幅度不是預期獲利。',
  '以實際 Demo 成交、費後損益與回撤判定結果。模型比較器是隔離研究，不會自動取代下單模型。',
  JSON.stringify(contract)].join('\n\n');
}
