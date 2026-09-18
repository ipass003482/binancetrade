import { join } from 'node:path';
import { z } from 'zod';
import { ROOT } from './paths.mjs';
import { readJson } from './io.mjs';
import { baselineDecision,BASELINE_VERSION } from './baseline.mjs';
import { orderFlowRuleDecision,demoRiskStake,DEMO_RULE_VERSION,FLOW_ONLY_PARAMETERS as DEMO_PARAMETERS } from './demo-rules.mjs';
import { checkDemoOrderSize } from './demo-order-size.mjs';
import { demoStrategyContract } from './strategy-contract.mjs';
import {volumeMinimum} from './volume-experiment.mjs';
import {demoRiskPolicy} from './demo-risk.mjs';
import {FLOW_SELECTIVITY} from './order-flow.mjs';
export const RULE_ENGINE_VERSION='demo-rule-exits-v12';
// Reject a config-only AI switch that bypasses structured Demo entry/exit plans.
export const DecisionConfigSchema=z.object({version:z.literal(1),demoEngine:z.literal('rules'),ruleVersion:z.literal(DEMO_RULE_VERSION)}).strict();
const Config=DecisionConfigSchema;
export async function loadDecisionConfig(){return Config.parse(await readJson(join(ROOT,'config/decision.json')));}
export function rulesProposal(snapshot,policy,account,modelEvidence,{excludedPairs=[]}={}){
 const live=policy.mode!=='dry-run',ruleVersion=live?DEMO_RULE_VERSION:BASELINE_VERSION;
 const used=account.trades.reduce((s,t)=>s+Number(t.stake_amount),0),available=Math.max(0,Number(policy.maxExposureUsdt)-used);
 const candidates=snapshot.markets.map(m=>{
  const rule=live?orderFlowRuleDecision({snapshot,pair:m.pair,cost:m.entryCost,modelEvidence,now:Date.parse(snapshot.completedAt??snapshot.createdAt)}):baselineDecision({candles:m.candles,timeframe:snapshot.timeframe,mode:policy.mode,pair:m.pair,cost:m.entryCost,now:Date.parse(snapshot.completedAt??snapshot.createdAt)});
  const stakeUsdt=rule.action==='hold'?'0':live?demoRiskStake(rule,m.entryCost,policy,available):policy.maxStakeUsdt;
  if(live&&rule.action!=='hold'){
   const sizing=checkDemoOrderSize({market:m,price:rule.action==='open-short'?m.bid:m.ask,stakeUsdt,leverage:1});
   if(!sizing.eligible)return {pair:m.pair,...rule,action:'hold',stakeUsdt:'0',sizingReason:'DEMO_RISK_SIZE_BELOW_EXCHANGE_MINIMUM',sizing};
  }
  return {pair:m.pair,...rule,stakeUsdt,...(live?{riskPolicy:demoRiskPolicy(policy.mode)}:{})};
 });
 const eligible=candidates.filter(c=>c.action!=='hold'&&!excludedPairs.includes(c.pair)&&!account.trades.some(t=>t.pair===c.pair));
 eligible.sort((a,b)=>(live?(Number(b.flowDiagnostics?.eligible===true)-Number(a.flowDiagnostics?.eligible===true)):0)||(policy.mode==='demo'?Number(b.flowStrength.delta)-Number(a.flowStrength.delta):0)||(live?Number(b.selectionScoreBps)-Number(a.selectionScoreBps):(b.targetFraction*10000-Number(b.requiredPriceSpaceBps))-(a.targetFraction*10000-Number(a.requiredPriceSpaceBps)))||a.pair.localeCompare(b.pair));
 const selected=eligible[0],futures=policy.mode==='demo-futures';
 const full=account.trades.length>=policy.maxOpenTrades||!selected||Number(selected.stakeUsdt)<=0||used+Number(selected.stakeUsdt)>Number(policy.maxExposureUsdt);
 const entry=selected&&!full;
 const pair=entry?selected.pair:policy.pairs[0];
 const proposal={snapshotId:snapshot.id,action:entry?selected.action:'hold',pair,stakeUsdt:entry?selected.stakeUsdt:'0',
  evidenceIds:entry?[(futures?'futures:':'spot:')+pair,'technical:'+pair,'cost:'+pair]:[],
  reason:entry?'策略 '+ruleVersion+'：'+(live?'訂單流成交力道與連續深度支持方向，且方向性中間價至少'+FLOW_SELECTIVITY.minimumMidChangeBps+' bps、五檔深度偏斜不超過'+(Number(FLOW_SELECTIVITY.maximumDepthImbalance)*100).toFixed(0)+'%；3 倍 ATR 目標扣除成本後至少覆蓋含成本停損風險，現貨優先依買盤深度優勢變化排序，再依計畫報酬與風險差排序，不是預期獲利。':'已收 K 突破。')+(selected.adaptiveParameters?'每分鐘評估；本筆依價差、成本與深度調整風險預算至 '+Number(selected.adaptiveParameters.riskBudgetUsdt).toFixed(4)+' USDT，成交力道門檻 '+(Number(selected.adaptiveParameters.minTakerShare)*100).toFixed(2)+'%。':'依 1 USDT 預估風險預算縮倉。')+'使用已收盤 15 分鐘 ATR 的停損／停利；最多持倉 4 小時。實際績效以 Demo 成交紀錄為準。':
   '策略 '+ruleVersion+'：'+(selected&&full?'持倉或曝險容量不足。':'訂單流資料、方向支持或成本後報酬／風險未通過。')+' 詳細排除原因保存在 rules.json；持倉由引擎管理退出。',...(futures?{leverage:1}:{})};
 return {proposal,candidates,selected:entry?selected:null,metadata:{decisionEngine:'rules',llmInvoked:false,ruleVersion,parameters:live?(snapshot.volumeExperiment?{...DEMO_PARAMETERS,relativeVolumeMinimum:volumeMinimum(snapshot)}:DEMO_PARAMETERS):null,
  ...(live?{entrySignalEngine:'sampled_order_flow',modelInvoked:false,modelUsedForDecision:false,modelStatus:modelEvidence?.status??'unavailable',modelReason:modelEvidence?.reason??null,modelFingerprint:modelEvidence?.modelFingerprint??null,predictionSha256:modelEvidence?.predictionSha256??null,volumeExperiment:snapshot.volumeExperiment??null,strategyContract:demoStrategyContract(policy,snapshot)}:{}),snapshotId:snapshot.id,timeframe:snapshot.timeframe??'15m',performanceSource:'demo-exchange-fills'}};
}
