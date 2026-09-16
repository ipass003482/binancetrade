// The bridge owns execution. This module only authenticates a prospective
// forecast against the exact saved cycle, pinned model and current worker.
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import Decimal from 'decimal.js';
import {ROOT} from './paths.mjs';
import {clockRange} from './exchange-clock.mjs';

const MODES=['demo','demo-futures'],MS=300000,MODEL='kronos-small-pretrained-v1';
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=code=>{throw Error('MODEL_'+code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const unavailable=error=>({status:'unavailable',entryAllowed:false,reason:/^MODEL_[A-Z_]+$/.test(error?.message??'')?error.message:'MODEL_EVIDENCE_UNAVAILABLE'});
function time(value){const n=typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;if(!Number.isSafeInteger(n)||n<0)fail('TIME_INVALID');return n;}
function decimal(value){
 if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!value.trim()))fail('NUMBER_INVALID');
 let n;try{n=new Decimal(value);}catch{fail('NUMBER_INVALID');}
 if(!n.isFinite()||n.lte(0)||Math.abs(n.e)>50)fail('NUMBER_INVALID');return n;
}
function reviewedConfig(config){
 const expected=['schemaVersion','enabled','model','modelFingerprint','maxWaitSeconds','maxPredictionAgeSeconds'];
 if(!object(config)||Object.keys(config).length!==expected.length||expected.some(k=>!Object.hasOwn(config,k))
  ||config.schemaVersion!==1||config.enabled!==true||config.model!==MODEL||!HEX.test(config.modelFingerprint??'')
  ||config.maxWaitSeconds!==35||config.maxPredictionAgeSeconds!==60)fail('EXECUTION_CONFIG_INVALID');
 return config;
}
function identity(snapshot){
 if(!object(snapshot)||!MODES.includes(snapshot.mode)||!UUID.test(snapshot.id??'')||snapshot.timeframe!=='5m'
  ||snapshot.purpose==='execution_probe'||!Number.isSafeInteger(snapshot.candleBoundary)||snapshot.candleBoundary%MS)fail('SNAPSHOT_IDENTITY');
 if(!Array.isArray(snapshot.markets)||snapshot.markets.length<1||snapshot.markets.length>(snapshot.mode==='demo'?10:4))fail('MARKET_IDENTITY');
 const pairs=new Set();
 for(const market of snapshot.markets){
  const pattern=snapshot.mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^(BTC|ETH|SOL|BNB)\/USDT:USDT$/;
  const source=snapshot.mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
  if(!object(market)||!pattern.test(market.pair??'')||pairs.has(market.pair)||market.mode!==snapshot.mode||market.source!==source
   ||market[snapshot.mode==='demo'?'verifiedSpot':'verifiedFutures']!==true)fail('MARKET_IDENTITY');
  pairs.add(market.pair);
  if(!Array.isArray(market.candles)||market.candles.length!==96)fail('CANDLE_INVALID');
  for(const [i,c] of market.candles.entries()){
   const start=snapshot.candleBoundary-(96-i)*MS;
   if(!object(c)||c.openTime!==start||c.closeTime!==start+MS-1)fail('CANDLE_INVALID');
   const [o,h,l,close]=['open','high','low','close'].map(k=>decimal(c[k]));
   let volume;try{volume=new Decimal(c.volume);}catch{fail('CANDLE_INVALID');}
   if(!['number','string'].includes(typeof c.volume)||!volume.isFinite()||volume.lt(0)||Math.abs(volume.e)>50
    ||h.lt(Decimal.max(o,l,close))||l.gt(Decimal.min(o,h,close)))fail('CANDLE_INVALID');
  }
 }
 return pairs;
}

export function validateModelEvidence({snapshot,prediction,input,status,loaded,config,review,now=Date.now(),snapshotSha256,predictionSha256,inputSha256}){
 try{
  reviewedConfig(config);const pairs=identity(snapshot),pin=config.modelFingerprint;
  if(!Number.isSafeInteger(now)||!HEX.test(snapshotSha256??'')||!HEX.test(predictionSha256??'')||!HEX.test(inputSha256??''))fail('HASH_OR_TIME_INVALID');
  if(!object(prediction)||prediction.schemaVersion!==1||prediction.source!=='frozen-pretrained-kronos'||prediction.model!==MODEL
   ||prediction.pretrained!==true||prediction.fineTuned!==false||prediction.executionRole!=='advisory'||prediction.usedForOrders!==false
   ||prediction.mode!==snapshot.mode||prediction.snapshotId!==snapshot.id||prediction.candleBoundary!==snapshot.candleBoundary
   ||prediction.snapshotSha256!==snapshotSha256||prediction.inputSha256!==inputSha256||prediction.modelFingerprint!==pin
   ||prediction.expectedPairs!==pairs.size||prediction.sampleCount!==4)fail('PREDICTION_IDENTITY');
  if(!object(loaded)||loaded.fingerprint!==pin||loaded.model!==MODEL||loaded.pretrained!==true||loaded.fineTuned!==false)fail('MODEL_IDENTITY');
  if(!object(status)||status.modelFingerprint!==pin||status.executionRole!=='advisory'||status.usedForOrders!==false
   ||!Number.isInteger(status.pid)||status.pid<=0||now-time(status.at)<0||now-time(status.at)>15000)fail('WORKER_STALE_OR_INVALID');
  if(!object(input)||input.mode!==snapshot.mode||input.snapshotId!==snapshot.id||input.snapshotSha256!==snapshotSha256
   ||input.candleBoundary!==snapshot.candleBoundary||!isDeepStrictEqual(input.clock,snapshot.clock)||!Array.isArray(input.inputs))fail('INPUT_IDENTITY');
  const created=time(snapshot.createdAt),completed=time(snapshot.completedAt),started=time(prediction.startedAt),issued=time(prediction.issuedAt);
  if(!(created<=completed&&completed<=started&&started<=issued&&issued<=now&&now-issued<=60000&&now-created<=60000))fail('PREDICTION_STALE_OR_FUTURE');
  let atIssue,current;try{atIssue=clockRange(snapshot.clock,snapshot.mode,issued);current=clockRange(snapshot.clock,snapshot.mode,now);}catch{fail('CLOCK_INVALID');}
  if(prediction.issuedExchangeLowerAt!==atIssue.lower||prediction.issuedExchangeUpperAt!==atIssue.upper
   ||atIssue.lower<snapshot.candleBoundary||atIssue.upper>=snapshot.candleBoundary+60000
   ||current.lower<snapshot.candleBoundary||current.upper>=snapshot.candleBoundary+60000)fail('PREDICTION_CLOCK_WINDOW');
  if(!Array.isArray(prediction.forecasts)||!prediction.forecasts.length||!Array.isArray(prediction.errors))fail('OUTPUT_PARTITION');
  const covered=new Set(),forecastPairs=new Set(),inputPairs=new Set();
  for(const row of prediction.forecasts){
   if(!object(row)||!pairs.has(row.pair)||covered.has(row.pair)||row.usedForOrders!==false||row.issuedAt!==prediction.issuedAt
    ||!Array.isArray(row.forecastCloses)||row.forecastCloses.length!==3||!Array.isArray(row.forecastBarOpens)||row.forecastBarOpens.length!==3
    ||row.forecastBarOpens.some((x,i)=>x!==snapshot.candleBoundary+i*MS)||row.targetCloseAt!==snapshot.candleBoundary+3*MS-1)fail('FORECAST_INVALID');
   row.forecastCloses.forEach(decimal);
   const market=snapshot.markets.find(m=>m.pair===row.pair);
   if(!decimal(row.originClose).eq(decimal(market.candles.at(-1).close)))fail('FORECAST_ORIGIN_MISMATCH');
   const actions=snapshot.mode==='demo'?['hold','buy']:['hold','open-long','open-short'];
   if(!actions.includes(row.advisoryAction)||!actions.includes(row.rawCostScreenedAction)||typeof row.suppressedByModelReview!=='boolean')fail('FORECAST_ACTION_INVALID');
   covered.add(row.pair);forecastPairs.add(row.pair);
  }
  for(const error of prediction.errors){
   if(!object(error)||!pairs.has(error.pair)||covered.has(error.pair)||!/^MODEL_[A-Z_]+$/.test(error.reason??''))fail('OUTPUT_PARTITION');
   covered.add(error.pair);
  }
  if(covered.size!==pairs.size)fail('OUTPUT_PARTITION');
  for(const row of input.inputs){
   if(!object(row)||!pairs.has(row.pair)||inputPairs.has(row.pair)||!Array.isArray(row.ohlcva)||row.ohlcva.length!==96)fail('INPUT_VALUES_INVALID');
   const market=snapshot.markets.find(m=>m.pair===row.pair),source=market.source+(snapshot.mode==='demo'?'/api/v3/klines':'/fapi/v1/klines');
   if(row.source!==source||!HEX.test(row.rawResponseSha256??'')||!Number.isSafeInteger(row.requestStartedAt)||!Number.isSafeInteger(row.receivedAt)
    ||row.requestStartedAt<started||row.receivedAt<row.requestStartedAt||row.receivedAt>issued)fail('INPUT_SOURCE_INVALID');
   for(const [i,values] of row.ohlcva.entries()){
    if(!Array.isArray(values)||values.length!==6||values.some(x=>typeof x!=='number'||!Number.isFinite(x))||values[5]<0
     ||['open','high','low','close','volume'].some((k,j)=>values[j]!==Number(market.candles[i][k])))fail('INPUT_VALUES_INVALID');
   }
   inputPairs.add(row.pair);
  }
  if([...forecastPairs].some(pair=>!inputPairs.has(pair)))fail('INPUT_PAIR_MISSING');
  if(!object(review)||review.schemaVersion!==1||review.modelFingerprint!==pin||review.usedForOrders!==false
   ||now-time(review.asOf)<0||now-time(review.asOf)>15000||!object(review.modes)
   ||Object.keys(review.modes).length!==2||MODES.some(mode=>!Object.hasOwn(review.modes,mode)))fail('REVIEW_STALE_OR_INVALID');
  for(const mode of MODES){
   const value=review.modes[mode];
   if(!object(value)||!['collecting','observing','underperforming_baseline','possible_degradation','stale_source','unavailable'].includes(value.status)
    ||typeof value.suppressAdvisoryEntries!=='boolean')fail('REVIEW_INVALID');
  }
  const modeReview=review.modes[snapshot.mode];
  const suppressed=['stale_source','unavailable'].includes(modeReview.status);
  // Only the old price-error diagnostic loses order authority. Missing, stale,
  // malformed, STOP and pinned-model checks still fail closed. The new host
  // strategy independently requires observed trend/pullback and net reward/risk.
  return {status:'ok',prediction,predictionSha256,modelFingerprint:pin,review,entryAllowed:!suppressed,
   reviewPolicyVersion:'pullback-diagnostic-mae-v1',diagnosticSuppressed:modeReview.suppressAdvisoryEntries,
   entryPolicyVersion:'trend-pullback-flow-v1',
   reason:suppressed?'MODEL_REVIEW_SUPPRESSED':null};
 }catch(error){return unavailable(error);}
}

// Re-run synchronously at the final send boundary, after all asynchronous work.
export function assertModelOrderTiming({snapshot,evidence,clock,now=Date.now()}){
 if(evidence?.status!=='ok'||evidence.entryAllowed!==true||!object(evidence.prediction))fail('ENTRY_NOT_ALLOWED');
 const prediction=evidence.prediction;
 if(!Number.isSafeInteger(now)||prediction.snapshotId!==snapshot.id||prediction.mode!==snapshot.mode
  ||prediction.candleBoundary!==snapshot.candleBoundary||prediction.modelFingerprint!==evidence.modelFingerprint)fail('PREDICTION_IDENTITY');
 const issued=time(prediction.issuedAt);
 if(issued>now||now-issued>60000)fail('PREDICTION_STALE_OR_FUTURE');
 let current;try{current=clockRange(clock,snapshot.mode,now);}catch{fail('CLOCK_INVALID');}
 if(current.lower<snapshot.candleBoundary||current.upper>=snapshot.candleBoundary+60000)fail('PREDICTION_CLOCK_WINDOW');
 return {modelFingerprint:evidence.modelFingerprint,predictionSha256:evidence.predictionSha256,
  issuedAt:prediction.issuedAt,exchangeUpperAt:current.upper,modelDeadline:snapshot.candleBoundary+60000};
}

async function readBounded(path){
 const info=await stat(path);if(!info.isFile()||info.size>2500000)fail('EVIDENCE_FILE_INVALID');
 const raw=await readFile(path);if(raw.length>2500000)fail('EVIDENCE_FILE_INVALID');
 return {value:JSON.parse(raw.toString('utf8')),sha256:sha(raw)};
}
async function stopped(base){try{await stat(join(base,'STOP'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export async function readModelEvidence({snapshot,local,root=ROOT,now=()=>Date.now()}){
 try{
  identity(snapshot);const base=join(root,'local/model-research');
  if(await stopped(base))fail('STOPPED');
  const saved=await readBounded(join(local,'runs',snapshot.id+'.snapshot.json'));
  if(!isDeepStrictEqual(saved.value,snapshot))fail('SNAPSHOT_CHANGED');
  const paths=[join(base,'predictions',snapshot.mode,snapshot.id+'.json'),join(base,'inputs',snapshot.mode,snapshot.id+'.json'),
   join(base,'status.json'),join(base,'loaded-model.json'),join(root,'config/model-execution.json'),join(base,'review.json')];
  const [prediction,input,status,loaded,config,review]=await Promise.all(paths.map(readBounded));
  if(await stopped(base))fail('STOPPED');
  return validateModelEvidence({snapshot,prediction:prediction.value,input:input.value,status:status.value,loaded:loaded.value,config:config.value,review:review.value,
   now:now(),snapshotSha256:saved.sha256,predictionSha256:prediction.sha256,inputSha256:input.sha256});
 }catch(error){return unavailable(error);}
}
export async function waitForModelEvidence({snapshot,local,root=ROOT,signal,now=()=>Date.now()}){
 if(signal?.aborted)return unavailable(Error('MODEL_WAIT_ABORTED'));
 let config;try{config=reviewedConfig((await readBounded(join(root,'config/model-execution.json'))).value);}catch(error){return unavailable(error);}
 const deadline=performance.now()+config.maxWaitSeconds*1000;
 for(;;){
  if(signal?.aborted)return unavailable(Error('MODEL_WAIT_ABORTED'));
  const result=await readModelEvidence({snapshot,local,root,now});
  if(result.status==='ok'||!['MODEL_EVIDENCE_UNAVAILABLE','MODEL_WORKER_STALE_OR_INVALID','MODEL_REVIEW_STALE_OR_INVALID'].includes(result.reason))return result;
  const remaining=deadline-performance.now();if(remaining<=0)return {...result,reason:'MODEL_WAIT_TIMEOUT',lastReason:result.reason};
  try{await delay(Math.min(200,remaining),undefined,{signal});}catch{return unavailable(Error('MODEL_WAIT_ABORTED'));}
 }
}
