import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadPolicy} from '../src/config.mjs';
import {buildAnalystPrompt} from '../src/analyst.mjs';
import {demoStrategyContract,renderDemoStrategyContract} from '../src/strategy-contract.mjs';
import {DEMO_PARAMETERS,DEMO_RULE_VERSION} from '../src/demo-rules.mjs';
import {RULE_ENGINE_VERSION,rulesProposal,DecisionConfigSchema} from '../src/decision.mjs';
import {runCycle} from '../src/workflow.mjs';
import {readJson} from '../src/io.mjs';
import {fixture,trendCandles,clockFixture,syntheticModelEvidence} from './fixtures.mjs';

test('Kev snapshot contract gives Kev pair and direction authority with no candle, ATR or Kronos entry dependency',async()=>{
 for(const mode of ['demo','demo-futures']){
  const policy=await loadPolicy(mode),contract=demoStrategyContract(policy,{entryPolicyVersion:'kev-order-flow-v1',
   kevEntry:{enabled:true,model:'test-model',decisionMode:'autonomous'}}),prompt=renderDemoStrategyContract(contract);
  assert.equal(contract.ruleVersion,'kev-order-flow-v1');assert.equal(contract.entrySignalEngine,'kev_order_flow');
  assert.equal(contract.model.role,'kev_order_flow_entry_authority');assert.equal(contract.modelAssist.enabled,false);
  assert.equal(contract.orderFlow.usedForEntryDecision,true);assert.equal(contract.kevEntryReview.enabled,true);
  assert.equal(contract.decisionCadence.entryIntervalMs,60000);assert.equal(contract.decisionCadence.candleTimeframe,null);
  assert.equal(contract.decisionCadence.atrTimeframe,null);assert.equal(contract.parameters.stopFraction,.005);
  assert.equal(contract.parameters.targetFraction,.015);assert.equal(contract.parameters.maxHoldingSeconds,900);
  assert.equal(contract.parameters.stopAtr,undefined);assert.equal(contract.entries.netRewardRiskGate,true);
  assert.match(contract.entries.confirmation,/kev-native-entry-v1/);assert.match(contract.entries.selection,/Kev autonomously/);
  assert.deepEqual(contract.entries.actions,mode==='demo'?['buy']:['open-long','open-short']);
  assert.match(prompt,/不收集 K 線或 ATR/);assert.match(prompt,/不等待 Kronos/);
  assert.equal(demoStrategyContract(policy).entryPolicyVersion,'forecast-net-edge-v1','Historical default is preserved.');
 }
});

test('Demo cannot bypass its structured entry/exit contract through a config-only AI switch',()=>{
 assert.throws(()=>DecisionConfigSchema.parse({version:1,demoEngine:'ai',ruleVersion:DEMO_RULE_VERSION}));
 assert.throws(()=>DecisionConfigSchema.parse({version:1,demoEngine:'rules',ruleVersion:'atr15m-forward-v7'}));
});

test('v12 contract matches the staged config and separates direction, ATR cost space and actual trade attribution',async()=>{
 const configured=JSON.parse(await readFile(new URL('../config/decision.json',import.meta.url),'utf8'));
 assert.equal(configured.ruleVersion,'kronos-direction-v12');
 assert.deepEqual(DecisionConfigSchema.parse(configured),configured);
 for(const mode of ['demo','demo-futures']){
  const contract=demoStrategyContract(await loadPolicy(mode)),prompt=renderDemoStrategyContract(contract);
  assert.equal(contract.ruleVersion,'kronos-direction-v12');
  assert.equal(contract.exits.nativeVersion,'demo-rule-exits-v12');
  assert.deepEqual(contract.entries.actions,mode==='demo'?['buy']:['open-long','open-short']);
  assert.equal(contract.directionCapabilities.short,mode==='demo'?null:'open-short');
  assert.equal(contract.directionCapabilities.shortReason,mode==='demo'?'SPOT_SHORT_REQUIRES_MARGIN':undefined);
  assert.equal(contract.entrySignalEngine,'kronos_ai');assert.equal(contract.entryPolicyVersion,'forecast-net-edge-v1');
  assert.match(contract.entries.direction,/three-step forecast/);assert.match(contract.entries.momentum,/pinned model direction/);
  assert.match(contract.entries.costs,/30bps/);assert.match(contract.entries.confirmation,/Native guard v10/);
  assert.equal(contract.adaptiveParameters.version,'live-flow-adaptive-v2');
  assert.equal(contract.adaptiveParameters.activeForNewAiEntries,false);
  assert.equal(contract.volatilityResponse.activeForNewAiEntries,false);
  assert.equal(contract.decisionCadence.intervalMs,60000);assert.equal(contract.decisionCadence.candleTimeframe,'5m');
  assert.equal(contract.decisionCadence.entryIntervalMs,300000);
  assert.equal(contract.decisionCadence.entryWindowMs,60000);
  assert.equal(contract.executionQuality,null);
  assert.equal(contract.entries.netRewardRiskGate,false);
  assert.equal(contract.model.usedForEntryDecision,true);assert.equal(contract.modelAssist.enabled,true);
  assert.equal(contract.sizing.riskBudgetUsdt,1);
  assert.equal(contract.parameters.stopAtr,1);assert.equal(contract.parameters.targetAtr,2);
  assert.equal(contract.parameters.stopFractionCap,.02);assert.equal(contract.parameters.maxHoldingSeconds,14400);
  assert.equal(contract.parameters.profitProtection.triggerNetUsdt,.5);
  assert.equal(contract.parameters.profitProtection.givebackNetUsdt,.25);
  assert.match(prompt,/已收盤 AI 三步預測選擇方向/);
  assert.match(prompt,/SPOT_SHORT_REQUIRES_MARGIN/);
  assert.match(contract.exits.plan,/Existing v11 positions retain their original plan/);
 }
});

test('both Demo prompt profiles use the same host contract as actual rules, without stale numeric instructions',async()=>{
 for(const mode of ['demo','demo-futures'])for(const style of ['active','conservative']){
  const policy=await loadPolicy(mode),snapshot={id:'review',mode,timeframe:'5m',createdAt:new Date().toISOString(),markets:[],
   strategyContract:{ruleVersion:'malicious',parameters:{relativeVolumeMinimum:0}}};
  const contract=demoStrategyContract(policy),rule=rulesProposal(snapshot,policy,{trades:[]}),
   result=await buildAnalystPrompt({snapshot,policy,analyst:{version:1,style}});
  assert.deepEqual(result.metadata.strategyContract,rule.metadata.strategyContract);
  assert.equal(contract.parameters,DEMO_PARAMETERS);assert.equal(contract.ruleVersion,DEMO_RULE_VERSION);
  assert.equal(contract.sizing.maxEntriesPerDay,'unlimited');
  assert.equal(contract.analystRole,'review_only');assert.equal(rule.metadata.llmInvoked,false);
  assert.ok(result.prompt.includes(JSON.stringify(contract)));
  assert.ok(!result.prompt.includes('15 分鐘價格結構'));assert.ok(!result.prompt.includes('額外 0.3%'));
  assert.ok(!result.prompt.includes('Entries use exactly host buyStakeUsdt'));
 }
});

test('Demo cycle archives the generated review prompt and uses AI as the entry direction',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-20T15:00:20Z')});
 const f=await fixture(),policy=await loadPolicy('demo'),local=await mkdtemp(join(tmpdir(),'demo-contract-'));
 const snapshot={...f.snapshot,mode:'demo',timeframe:'5m',candleBoundary:Math.floor(f.now/300000)*300000,clock:clockFixture(f.now,'demo')};
 snapshot.markets[0]={...snapshot.markets[0],candles:trendCandles(f.now,'long','5m'),clock:snapshot.clock};
 let executed=false;
 await runCycle({local,policy,client:{snapshot:async()=>({...f.account,engine:{strategy_version:RULE_ENGINE_VERSION}})},
  kevConfigFn:async()=>({enabled:false,marketData:'kronos'}),
  collectFn:async()=>snapshot,costsFn:async()=>({mode:'demo',kind:'costs',readOnly:true,source:'https://demo-api.binance.com',observedAt:new Date(f.now).toISOString(),rates:[]}),
  modelEvidenceFn:async({snapshot:collected})=>syntheticModelEvidence(collected),
  analyzeFn:async()=>{throw Error('AI_MUST_NOT_DECIDE_RULE_MODE');},
  executeFn:async()=>{
   const saved=await readJson(join(local,'runs',snapshot.id+'.prompt-contract.json')),
    analysis=await readJson(join(local,'runs',snapshot.id+'.analysis.json'));
   assert.equal(saved.llmInvoked,false);assert.equal(saved.role,'review_only');
   assert.deepEqual(saved.strategyContract,analysis.strategyContract);
   assert.equal(analysis.decisionEngine,'rules');assert.equal(analysis.llmInvoked,false);
   assert.equal(analysis.entrySignalEngine,'kronos_ai');assert.equal(analysis.modelInvoked,true);
   assert.equal(typeof analysis.modelUsedForDecision,'boolean');assert.equal(analysis.modelStatus,'ok');
   assert.equal(analysis.predictionSha256,'a'.repeat(64));assert.equal(analysis.modelFingerprint,'b'.repeat(64));
   assert.ok((await readFile(join(local,'runs',snapshot.id+'.review-prompt.txt'),'utf8')).includes(DEMO_RULE_VERSION));
   executed=true;return {status:'hold'};
  }});
 assert.equal(executed,true);
});
