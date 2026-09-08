import { loadPolicy } from '../src/config.mjs';
import { writeJson,readJson } from '../src/io.mjs';
import { analyze } from '../src/codex.mjs';
import { FreqtradeClient } from '../src/freqtrade.mjs';
import { modeArgs,modeLocal } from '../src/mode.mjs';
import { runCycle } from '../src/workflow.mjs';
import { join } from 'node:path';
const {mode,args}=modeArgs(process.argv.slice(2));if(args.length)throw new Error('INVALID_ARGUMENTS');
const local=modeLocal(mode),policy=await loadPolicy(mode),client=new FreqtradeClient(policy,await readJson(join(local,'api-auth.json')));
const result=await runCycle({policy,client,local:join(local,'codex-smoke'),
 analyzeFn:(snapshot,p,account,options)=>analyze(snapshot,p,account,{...options,forceHold:true})});
if(result.result.status!=='hold')throw new Error('Expected HOLD');
await writeJson(join(local,'codex-smoke/result.json'),{...result,at:new Date().toISOString()});
console.log(JSON.stringify({status:'passed',mode,codexProposal:result.proposal.action,bridgeResult:result.result.status,ordersSubmitted:0}));
