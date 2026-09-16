import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateModelEvidence,readModelEvidence,waitForModelEvidence,assertModelOrderTiming} from '../src/model-entry.mjs';

const MS=300000,BOUNDARY=1789347600000,PIN='a'.repeat(64),ID='12345678-1234-1234-1234-123456789abc';
const iso=n=>new Date(n).toISOString(),digest=s=>createHash('sha256').update(s).digest('hex');
function fixture(mode='demo'){
 const source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 const pairs=mode==='demo'?['BTC/USDT','ETH/USDT']:['BTC/USDT:USDT','ETH/USDT:USDT'];
 const clock={mode,source:source+(mode==='demo'?'/api/v3/time':'/fapi/v1/time'),requestStartedAt:BOUNDARY+1000,receivedAt:BOUNDARY+1100,serverTime:BOUNDARY+1050};
 const markets=pairs.map(pair=>({pair,mode,source,[mode==='demo'?'verifiedSpot':'verifiedFutures']:true,
  candles:Array.from({length:96},(_,i)=>({openTime:BOUNDARY-(96-i)*MS,closeTime:BOUNDARY-(96-i)*MS+MS-1,open:'100',high:'101',low:'99',close:'100',volume:'25'}))}));
 const snapshot={id:ID,mode,timeframe:'5m',createdAt:iso(BOUNDARY+1100),completedAt:iso(BOUNDARY+2000),candleBoundary:BOUNDARY,clock,markets};
 const prediction={schemaVersion:1,source:'frozen-pretrained-kronos',model:'kronos-small-pretrained-v1',modelFingerprint:PIN,pretrained:true,fineTuned:false,
  mode,snapshotId:ID,snapshotSha256:'b'.repeat(64),inputSha256:'c'.repeat(64),candleBoundary:BOUNDARY,startedAt:iso(BOUNDARY+3000),issuedAt:iso(BOUNDARY+5000),
  issuedExchangeLowerAt:BOUNDARY+4950,issuedExchangeUpperAt:BOUNDARY+5050,sampleCount:4,expectedPairs:2,executionRole:'advisory',usedForOrders:false,errors:[],
  forecasts:pairs.map(pair=>({pair,originClose:'100',forecastCloses:['101','102','103'],forecastBarOpens:[BOUNDARY,BOUNDARY+MS,BOUNDARY+2*MS],targetCloseAt:BOUNDARY+3*MS-1,
   issuedAt:iso(BOUNDARY+5000),usedForOrders:false,advisoryAction:mode==='demo'?'buy':'open-long',rawCostScreenedAction:mode==='demo'?'buy':'open-long',suppressedByModelReview:false}))};
 const input={snapshotId:ID,mode,snapshotSha256:'b'.repeat(64),candleBoundary:BOUNDARY,clock,
  inputs:pairs.map(pair=>({pair,source:source+(mode==='demo'?'/api/v3/klines':'/fapi/v1/klines'),requestStartedAt:BOUNDARY+3100,receivedAt:BOUNDARY+3500,
   rawResponseSha256:'e'.repeat(64),ohlcva:Array.from({length:96},()=>[100,101,99,100,25,2500])}))};
 const status={pid:123,at:iso(BOUNDARY+5500),modelFingerprint:PIN,executionRole:'advisory',usedForOrders:false};
 const loaded={fingerprint:PIN,model:'kronos-small-pretrained-v1',pretrained:true,fineTuned:false};
 const config={schemaVersion:1,enabled:true,model:'kronos-small-pretrained-v1',modelFingerprint:PIN,maxWaitSeconds:35,maxPredictionAgeSeconds:60};
 const review={schemaVersion:1,asOf:iso(BOUNDARY+5500),modelFingerprint:PIN,usedForOrders:false,modes:Object.fromEntries(['demo','demo-futures'].map(m=>[m,{status:'collecting',suppressAdvisoryEntries:false}]))};
 return {snapshot,prediction,input,status,loaded,config,review,now:BOUNDARY+6000,snapshotSha256:'b'.repeat(64),inputSha256:'c'.repeat(64),predictionSha256:'d'.repeat(64)};
}
const rejected=(f,code)=>assert.equal(validateModelEvidence(f).reason,code);

test('exact prospective spot and futures evidence permits model review during collecting',()=>{
 for(const mode of ['demo','demo-futures']){const f=fixture(mode),result=validateModelEvidence(f);assert.equal(result.status,'ok');assert.equal(result.entryAllowed,true);assert.equal(result.predictionSha256,f.predictionSha256);}
});

test('producer cost-screened HOLD remains valid evidence for a separately enforced host direction rule',()=>{
 for(const mode of ['demo','demo-futures']){
  const f=fixture(mode);
  for(const row of f.prediction.forecasts){row.forecastCloses=['100.01','100.02','100.03'];row.rawCostScreenedAction='hold';row.advisoryAction='hold';}
  const before=structuredClone(f.prediction),result=validateModelEvidence(f);
  assert.equal(result.status,'ok');assert.equal(result.entryAllowed,true);
  assert.deepEqual(result.prediction,before);assert.deepEqual(f.prediction,before);
  f.review.modes[mode].suppressAdvisoryEntries=true;
  assert.equal(validateModelEvidence(f).entryAllowed,true,'MAE suppression is diagnostic for the separate price-triggered strategy');
  assert.equal(validateModelEvidence(f).diagnosticSuppressed,true);
 }
});
test('pinned model, snapshot bytes and model input bytes cannot be substituted',()=>{
 for(const [key,value] of [['modelFingerprint','f'.repeat(64)],['snapshotSha256','f'.repeat(64)],['inputSha256','f'.repeat(64)],['snapshotId','23456789-1234-1234-1234-123456789abc'],['mode','demo-futures']]){
  const f=fixture();f.prediction[key]=value;rejected(f,'MODEL_PREDICTION_IDENTITY');
 }
 const f=fixture();f.loaded.fingerprint='f'.repeat(64);rejected(f,'MODEL_MODEL_IDENTITY');
});
test('worker and review freshness are required and a future heartbeat is invalid',()=>{
 for(const offset of [-16000,1]){const f=fixture();f.status.at=iso(f.now+offset);rejected(f,'MODEL_WORKER_STALE_OR_INVALID');}
 const f=fixture();f.review.asOf=iso(f.now-16000);rejected(f,'MODEL_REVIEW_STALE_OR_INVALID');
});
test('prediction must follow completed source collection and precede current time',()=>{
 const f=fixture();f.prediction.startedAt=iso(BOUNDARY+1999);rejected(f,'MODEL_PREDICTION_STALE_OR_FUTURE');
 const future=fixture();future.prediction.issuedAt=iso(future.now+1);rejected(future,'MODEL_PREDICTION_STALE_OR_FUTURE');
});
test('archived exchange bounds are verified and the full upper bound must remain in first minute',()=>{
 const f=fixture();f.prediction.issuedExchangeUpperAt++;rejected(f,'MODEL_PREDICTION_CLOCK_WINDOW');
 const late=fixture();late.now=BOUNDARY+59950;late.status.at=iso(late.now);late.review.asOf=iso(late.now);rejected(late,'MODEL_PREDICTION_CLOCK_WINDOW');
});
test('forecast target, origin and positive finite three-bar closes are mandatory',()=>{
 const origin=fixture();origin.prediction.forecasts[0].originClose='101';rejected(origin,'MODEL_FORECAST_ORIGIN_MISMATCH');
 const target=fixture();target.prediction.forecasts[0].targetCloseAt--;rejected(target,'MODEL_FORECAST_INVALID');
 for(const close of ['NaN','Infinity','0','-1',true]){const f=fixture();f.prediction.forecasts[0].forecastCloses[1]=close;rejected(f,'MODEL_NUMBER_INVALID');}
});
test('revised source inputs and candle gaps cannot authorize a model forecast',()=>{
 const f=fixture();f.input.inputs[0].ohlcva[0][3]=100.1;rejected(f,'MODEL_INPUT_VALUES_INVALID');
 const gap=fixture();gap.snapshot.markets[0].candles[1].openTime++;rejected(gap,'MODEL_CANDLE_INVALID');
});
test('forecast and error records must form an exact unique market partition',()=>{
 const f=fixture();f.prediction.forecasts.pop();rejected(f,'MODEL_OUTPUT_PARTITION');
 const duplicate=fixture();duplicate.prediction.forecasts[1]=structuredClone(duplicate.prediction.forecasts[0]);rejected(duplicate,'MODEL_FORECAST_INVALID');
 const err=fixture();err.prediction.errors.push({pair:'BTC/USDT',reason:'MODEL_PROVIDER_CANDLE_REVISED'});rejected(err,'MODEL_OUTPUT_PARTITION');
});
test('valid partial model output remains eligible only for its actually predicted pairs',()=>{
 const f=fixture();f.prediction.forecasts.pop();f.input.inputs.pop();f.prediction.errors.push({pair:'ETH/USDT',reason:'MODEL_PROVIDER_CANDLE_REVISED'});
 const result=validateModelEvidence(f);assert.equal(result.status,'ok');assert.equal(result.entryAllowed,true);assert.deepEqual(result.prediction.forecasts.map(r=>r.pair),['BTC/USDT']);
});
test('spot short records and unapproved futures symbols are rejected',()=>{
 const spot=fixture();spot.prediction.forecasts[0].advisoryAction='open-short';rejected(spot,'MODEL_FORECAST_ACTION_INVALID');
 const fut=fixture('demo-futures');fut.snapshot.markets[0].pair='XRP/USDT:USDT';rejected(fut,'MODEL_MARKET_IDENTITY');
 const short=fixture('demo-futures');short.prediction.forecasts[0].advisoryAction='open-short';short.prediction.forecasts[0].rawCostScreenedAction='open-short';short.prediction.forecasts[0].forecastCloses=['99','98','97'];assert.equal(validateModelEvidence(short).status,'ok');
});
test('model degradation or suppress flags produce a valid hold, including suppression at issuance',()=>{
 for(const status of ['stale_source','unavailable']){const f=fixture();f.review.modes.demo.status=status;const result=validateModelEvidence(f);assert.equal(result.status,'ok');assert.equal(result.entryAllowed,false);assert.equal(result.reason,'MODEL_REVIEW_SUPPRESSED');}
 for(const status of ['possible_degradation','underperforming_baseline']){const f=fixture();f.review.modes.demo.status=status;f.review.modes.demo.suppressAdvisoryEntries=true;f.prediction.forecasts[0].suppressedByModelReview=true;assert.equal(validateModelEvidence(f).entryAllowed,true);assert.equal(validateModelEvidence(f).diagnosticSuppressed,true);}
 const f=fixture();f.prediction.forecasts[0].suppressedByModelReview=true;assert.equal(validateModelEvidence(f).entryAllowed,true);
});
test('final synchronous timing guard expires after asynchronous work',()=>{
 const f=fixture(),evidence=validateModelEvidence(f);assert.doesNotThrow(()=>assertModelOrderTiming({snapshot:f.snapshot,evidence,clock:f.snapshot.clock,now:f.now}));
 assert.throws(()=>assertModelOrderTiming({snapshot:f.snapshot,evidence,clock:f.snapshot.clock,now:BOUNDARY+59950}),/MODEL_PREDICTION_CLOCK_WINDOW/);
 evidence.entryAllowed=false;assert.throws(()=>assertModelOrderTiming({snapshot:f.snapshot,evidence,clock:f.snapshot.clock,now:f.now}),/MODEL_ENTRY_NOT_ALLOWED/);
});

async function diskFixture(t){
 const root=await mkdtemp(join(tmpdir(),'binancetrade-model-evidence-'));
 t.after(()=>rm(root,{recursive:true,force:true}));const f=fixture(),local=join(root,'local','demo'),base=join(root,'local','model-research');
 const save=async(path,value)=>{await mkdir(join(path,'..'),{recursive:true});const bytes=JSON.stringify(value)+'\n';await writeFile(path,bytes,'utf8');return digest(bytes);};
 f.snapshotSha256=await save(join(local,'runs',ID+'.snapshot.json'),f.snapshot);f.prediction.snapshotSha256=f.snapshotSha256;f.input.snapshotSha256=f.snapshotSha256;
 f.inputSha256=await save(join(base,'inputs','demo',ID+'.json'),f.input);f.prediction.inputSha256=f.inputSha256;
 f.predictionSha256=await save(join(base,'predictions','demo',ID+'.json'),f.prediction);
 await save(join(base,'status.json'),f.status);await save(join(base,'loaded-model.json'),f.loaded);await save(join(base,'review.json'),f.review);await save(join(root,'config','model-execution.json'),f.config);
 return {f,root,local,base,save,args:{snapshot:f.snapshot,root,local,now:()=>f.now}};
}
test('filesystem reader verifies exact snapshot and byte hashes without trusting latest pointers',async t=>{
 const d=await diskFixture(t);assert.equal((await readModelEvidence(d.args)).status,'ok');
 await d.save(join(d.base,'latest-demo.json'),{forged:true});assert.equal((await readModelEvidence(d.args)).status,'ok');
 const changed=structuredClone(d.f.snapshot);changed.modelEvidence={forged:true};assert.equal((await readModelEvidence({...d.args,snapshot:changed})).reason,'MODEL_SNAPSHOT_CHANGED');
});
test('model STOP, missing prediction and modified input archive return readable HOLD reasons',async t=>{
 const d=await diskFixture(t);await writeFile(join(d.base,'STOP'),'paused');assert.equal((await readModelEvidence(d.args)).reason,'MODEL_STOPPED');await rm(join(d.base,'STOP'));
 d.f.input.inputs[0].ohlcva[0][5]=1;await d.save(join(d.base,'inputs','demo',ID+'.json'),d.f.input);assert.equal((await readModelEvidence(d.args)).reason,'MODEL_PREDICTION_IDENTITY');
 await rm(join(d.base,'predictions','demo',ID+'.json'));assert.equal((await readModelEvidence(d.args)).reason,'MODEL_EVIDENCE_UNAVAILABLE');
});
test('bounded polling returns only the exact ready prediction and is abortable when missing',async t=>{
 const d=await diskFixture(t);assert.equal((await waitForModelEvidence(d.args)).status,'ok');
 await rm(join(d.base,'predictions','demo',ID+'.json'));const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),40);t.after(()=>clearTimeout(timer));
 assert.equal((await waitForModelEvidence({...d.args,signal:controller.signal})).reason,'MODEL_WAIT_ABORTED');
});
