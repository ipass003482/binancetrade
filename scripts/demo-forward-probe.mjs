// One explicitly authorized real Demo round trip per invocation. No retries.
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { modeArgs,modeLocal } from '../src/mode.mjs';
import { loadPolicy } from '../src/config.mjs';
import { exists,lock,readJson,writeJson } from '../src/io.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { collect } from '../src/research.mjs';
import { collectCosts,attachCosts,loadCosts } from '../src/trading-costs.mjs';
import { execute } from '../src/bridge.mjs';
import { createProbePermit,probeSpec,probeFillEvidence } from '../src/demo-probe.mjs';
import { beginForwardTrial,refreshForwardReport } from '../src/forward-store.mjs';
import { DEMO_PARAMETERS,DEMO_RULE_VERSION } from '../src/demo-rules.mjs';
import { RULE_ENGINE_VERSION } from '../src/decision.mjs';
import { safeError } from '../src/health.mjs';
const out=x=>console.log(JSON.stringify(x));
const {mode,args}=modeArgs(process.argv.slice(2));
async function main(){
 const spec=probeSpec(mode),local=modeLocal(mode);
 if(args.length!==1||args[0]!=='--allow-demo-orders')throw Error('PROBE_EXPLICIT_AUTHORIZATION_REQUIRED');
 if(await exists(join(local,'watch.lock'))||await exists(join(local,'STOP')))throw Error('PROBE_REQUIRES_ENABLED_EXCLUSIVE_ENTRY');
 return lock(join(local,'cycle.lock'),async()=>{
  const policy=await loadPolicy(mode),client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
  const before=await client.snapshot();
  if(before.trades.length||before.engine.strategy_version!==RULE_ENGINE_VERSION)throw Error('PROBE_REQUIRES_EMPTY_CURRENT_DEMO_ENGINE');
  const history=await client.history();
  await beginForwardTrial(local,mode,history,{ruleVersion:DEMO_RULE_VERSION,parameters:DEMO_PARAMETERS});
  const facts=await collectCosts(policy),snapshot=await collect(policy);
  attachCosts(snapshot,facts,await loadCosts());snapshot.decisionEngine='rules';snapshot.purpose='execution_probe';
  const proposal={snapshotId:snapshot.id,pair:spec.pair,action:spec.action,stakeUsdt:spec.stakeUsdt,
   evidenceIds:[(mode==='demo'?'spot:':'futures:')+spec.pair,'cost:'+spec.pair],
   reason:'使用者授權的小額 Demo 開倉與自動退出驗證單；獨立記錄，不列入策略成績。',...(mode==='demo-futures'?{leverage:1}:{})};
  const permit=await createProbePermit(local,mode,snapshot,{allowDemoOrders:true});
  await writeJson(join(local,'runs',snapshot.id+'.snapshot.json'),snapshot);
  await writeJson(join(local,'runs',snapshot.id+'.proposal.json'),proposal);
  const result=await execute({proposal,snapshot,policy,client,local,probePermitId:permit.id});
  if(result.status!=='submitted')throw Error('PROBE_NOT_SUBMITTED');
  out({mode,stage:'submitted',...result});
  const file=join(local,'probe-result-'+permit.id+'.json'),deadline=Date.now()+180000;
  let announced=false,protectionEvidence=[];
  while(Date.now()<deadline){
   let trades;
   try{trades=await client.history();}
   catch(error){
    // A native close may occur between history pages. Retry this read only;
    // the one submitted entry above is never repeated.
    if(String(error?.message).startsWith('HISTORY_CHANGED')){await delay(1000);continue;}
    throw error;
   }
   const trade=trades.find(t=>t.trade_id===result.tradeId&&t.enter_tag===result.tag);
   if(trade){
    if(await exists(join(local,'protection-readiness.json'))){
     const state=await readJson(join(local,'protection-readiness.json'));
     const matched=(state.activeStops??[]).filter(s=>s.pair===trade.pair);
     for(const stop of matched)if(!protectionEvidence.some(s=>s.orderId===stop.orderId))protectionEvidence.push({...stop,readinessAsOf:state.asOf});
    }
    const evidence=probeFillEvidence(trade),record={mode,purpose:'execution_probe',observedAt:new Date().toISOString(),result,trade,evidence,protectionEvidence};
    await writeJson(file,record);
    if(!announced&&evidence.entryVerified){out({mode,stage:'filled',tradeId:trade.trade_id,pair:trade.pair,isShort:trade.is_short,amount:trade.amount,openRate:trade.open_rate,stake:trade.stake_amount,...evidence});announced=true;}
    if(evidence.roundTripVerified){
     await refreshForwardReport(local,client);
     out({mode,stage:'closed',tradeId:trade.trade_id,pair:trade.pair,netProfitUsdt:trade.profit_abs,exitReason:trade.exit_reason,...evidence,protectionEvidence,file});return;
    }
   }
   await delay(3000);
  }
  throw Error('PROBE_CLOSE_NOT_VERIFIED: inspect saved result and engine; do not resend');
 });
}
main().catch(e=>{out({mode,error:safeError(e)});process.exitCode=1;});
