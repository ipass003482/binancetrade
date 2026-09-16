// Research-only join of entry-time evidence and actual Demo outcomes. No orders.
import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {technicalSummary} from './research-profile.mjs';
import {canonical} from './strategy-version.mjs';
import {journalRead} from './io.mjs';
import {clockRange} from './exchange-clock.mjs';

export const LEARNING_SCHEMA='demo-entry-outcomes-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error('LEARNING_'+code);};
const decimal=value=>{
 if(!['number','string'].includes(typeof value)||String(value).trim()==='')fail('NUMBER_INVALID');
 const n=new Decimal(value);if(!n.isFinite()||Math.abs(n.e)>50)fail('NUMBER_INVALID');return n;
};
const time=value=>{const n=typeof value==='number'?value:Date.parse(value);if(!Number.isSafeInteger(n)||n<0)fail('TIME_INVALID');return n;};
const sum=values=>values.reduce((a,b)=>a.plus(b),new Decimal(0));
const median=values=>{if(!values.length)return null;const a=values.map(decimal).sort((x,y)=>x.cmp(y)),m=Math.floor(a.length/2);return (a.length%2?a[m]:a[m-1].plus(a[m]).div(2)).toFixed();};

export function estimatedNetPayoff(plan){
 const stop=decimal(plan.stopFraction),target=decimal(plan.targetFraction),cost=decimal(plan.riskCostFraction);
 if(stop.lte(0)||target.lte(0)||stop.gt(1)||target.gt(1)||cost.lt(0)||cost.gt(1))fail('PAYOFF_INVALID');
 const gain=target.minus(cost),loss=stop.plus(cost);
 return {grossRewardRisk:target.div(stop).toFixed(),estimatedRoundTripCostBps:cost.mul(10000).toFixed(),
  targetNetBps:gain.mul(10000).toFixed(),stopLossIncludingCostsBps:loss.mul(10000).toFixed(),
  netRewardRisk:gain.div(loss).toFixed(),twoOutcomeBreakEvenWinRate:gain.gt(0)?loss.div(loss.plus(gain)).toFixed():null,
  basis:'Entry-time estimated costs and original target/stop distances only. Two-outcome payoff arithmetic, not expected return or a predicted win rate; trailing/time exits and actual costs differ.'};
}

export function learningRow({mode,trade:t,plan:p,snapshot:s,quote:q,cost,version:v,records=[],asOf}){
 if(!['demo','demo-futures'].includes(mode))fail('MODE_INVALID');
 if(p?.purpose!=='strategy'||!['atr15m-forward-v9','atr15m-forward-v10'].includes(p?.ruleVersion))fail('UNSUPPORTED_STRATEGY');
 if(!/^[a-f0-9-]{36}$/i.test(s?.id??'')||s.mode!==mode||s.timeframe!=='5m'||s.decisionEngine!=='rules'||
  s.ruleVersion!==p.ruleVersion||p.timeframe!=='5m'||p.snapshotId!==s.id)fail('SNAPSHOT_IDENTITY');
 const tag='codex-'+hash(s.id).slice(0,32),short=mode==='demo-futures'&&t.is_short;
 if(!Number.isSafeInteger(t.trade_id)||t.trade_id<=0||typeof t.is_short!=='boolean'||typeof t.is_open!=='boolean'||
  p.tag!==tag||t.enter_tag!==tag||p.pair!==t.pair||p.isShort!==short||mode==='demo'&&t.is_short||
  !(mode==='demo'?/^[A-Z0-9]+\/USDT$/:/^[A-Z0-9]+\/USDT:USDT$/).test(t.pair))fail('TRADE_IDENTITY');
 const entries=records.filter(r=>r.tag===tag&&r.status==='pending');
 const settled=records.filter(r=>r.id===tag.slice(6)&&['submitted','reconciled'].includes(r.status));
 if(entries.length!==1||settled.length!==1||entries[0].id!==tag.slice(6)||entries[0].snapshotId!==s.id||
  entries[0].pair!==t.pair||entries[0].ruleVersion!==p.ruleVersion||entries[0].purpose!=='strategy'||
  entries[0].action!==(mode==='demo'?'buy':short?'open-short':'open-long')||settled[0].tradeId!==t.trade_id||
  settled[0].action!==entries[0].action||settled[0].status==='submitted'&&(settled[0].pair!==t.pair||settled[0].tag!==tag)||
  settled[0].status==='reconciled'&&!settled[0].proof)fail('JOURNAL_IDENTITY');
 const {fingerprint,capturedAt,scope,...contract}=v??{};
 if(v?.schemaVersion!==1||v.mode!==mode||fingerprint!==hash(JSON.stringify(canonical(contract))))fail('VERSION_MANIFEST');
 const source=mode==='demo'?'https://demo-api.binance.com':'https://demo-fapi.binance.com';
 const matches=s.markets?.filter(m=>m.pair===t.pair)??[],m=matches[0];
 if(matches.length!==1||m.source!==source||q?.source!==source||q.mode!==mode||q.pair!==t.pair||
  (mode==='demo'?m.verifiedSpot!==true||q.verifiedSpot!==true:m.verifiedFutures!==true||q.verifiedFutures!==true)||
  cost?.status!=='ok'||cost.mode!==mode||cost.pair!==t.pair||cost.source!==source)fail('DATA_SOURCE');
 const boundary=time(s.candleBoundary),snapshotAt=time(s.createdAt),planAt=time(p.createdAt),
  quoteAt=time(q.fetchedAt),firstFill=time(t.open_fill_timestamp),opened=time(t.open_timestamp),now=time(asOf),
  informationLocalAt=Math.max(time(s.completedAt),quoteAt,time(capturedAt),planAt,time(cost.observedAt),time(entries[0].at));
 // Candles and order fills use exchange time; saved evidence and engine trade
 // creation use local time. Use the recorded clock interval, never a current
 // clock or a fixed tolerance that could admit post-fill evidence.
 let snapshotRange,quoteRange,informationRange;
 try{
  snapshotRange=clockRange(s.clock,mode,snapshotAt);
  quoteRange=clockRange(q.clock,mode,quoteAt);
  informationRange=clockRange(q.clock,mode,informationLocalAt);
 }catch{fail('ENTRY_CLOCK_INVALID');}
 const informationAt=informationRange.upper;
 if(boundary%300000||Math.floor(snapshotRange.lower/300000)*300000!==boundary||
  Math.floor(snapshotRange.upper/300000)*300000!==boundary||planAt<snapshotAt||quoteAt<snapshotAt||
  informationAt>firstFill||opened<informationLocalAt||opened>now||firstFill<boundary||
  firstFill-boundary>=300000||firstFill-quoteRange.lower>15000||
  !Array.isArray(m.candles)||m.candles.length!==96||m.candles.at(-1).closeTime!==boundary-1)fail('ENTRY_TIME_OR_FUTURE_DATA');
 const technical=technicalSummary(m.candles,'5m'),entry=p.entryConfirmation;
 if(entry?.version!=='retest-reclaim-v1'||entry.confirmationAt!==boundary||entry.signalAt!==boundary-300000||
  !decimal(entry.close).eq(technical.lastClose)||!decimal(cost.estimatedRoundTripCostBps).div(10000).minus(p.riskCostFraction).abs().lte('1e-15'))fail('PLAN_MISMATCH');
 const bid=decimal(q.bid),ask=decimal(q.ask),close=decimal(technical.lastClose),trigger=decimal(entry.trigger),
  atr=decimal(technical.atr14),sign=short?-1:1;
 if(bid.lte(0)||ask.lt(bid)||trigger.lte(0)||atr.lte(0))fail('QUOTE_INVALID');
 const price=short?bid:ask,payoff=estimatedNetPayoff(p),fill=decimal(t.open_rate),amount=decimal(t.amount);
 if(fill.lte(0)||amount.lte(0))fail('FILL_INVALID');
 const maxHold=time(p.maxHoldingSeconds)*1000;
 if(maxHold!==14400000)fail('HOLDING_CONTRACT');
 let outcome=null;
 if(!t.is_open){
  const closed=time(t.close_timestamp);if(closed<opened||closed>now)fail('OUTCOME_TIME');
  const net=decimal(t.profit_abs),notional=fill.mul(amount);
  outcome={closedAt:closed,netRealizedUsdt:net.toFixed(),netReturnOnEntryNotionalBps:net.div(notional).mul(10000).toFixed(),
   profitable:net.gt(0),holdingSeconds:(closed-firstFill)/1000,exitReason:t.exit_reason??null,
   exceedsPlannedHolding:closed-firstFill>maxHold+300000};
 }
 // Explicit whitelist: neither outcomes, fill prices, close reasons nor peaks
 // are predictors. Every feature here was observable before the entry fill.
 const features={return1hPct:technical.return1hPct,return4hPct:technical.return4hPct,
  priceVsSma8Bps:close.div(technical.sma8).minus(1).mul(10000).toFixed(),
  priceVsSma20Bps:close.div(technical.sma20).minus(1).mul(10000).toFixed(),
  atr5Bps:atr.div(close).mul(10000).toFixed(),relativeVolume:technical.volumeVsPrior19,
  spreadBps:ask.minus(bid).div(bid).mul(10000).toFixed(),
  signedQuoteVsCloseBps:price.div(close).minus(1).mul(sign*10000).toFixed(),
  signedQuoteVsTriggerAtr:price.minus(trigger).mul(sign).div(atr).toFixed(),
  estimatedRoundTripCostBps:payoff.estimatedRoundTripCostBps,netRewardRisk:payoff.netRewardRisk};
 if(Object.values(features).some(value=>value===null))fail('FEATURE_UNAVAILABLE');
 return {schema:LEARNING_SCHEMA,key:mode+':'+t.trade_id,mode,tradeId:t.trade_id,pair:t.pair,
  direction:short?'short':'long',ruleVersion:p.ruleVersion,strategyFingerprint:fingerprint,
  snapshotId:s.id,tag,provider:source,featureStartAt:m.candles[0].openTime,featureAsOf:boundary-1,
  informationAt,entryFillAt:firstFill,features,estimatedPayoff:payoff,outcome,
  timing:{informationLocalAt,informationExchangeRange:informationRange,quoteExchangeRange:quoteRange,
   snapshotClock:s.clock,quoteClock:q.clock,informationAtBasis:'Conservative upper exchange-time bound from the archived pre-entry clock; fill and candles are exchange timestamps.'},
  execution:{quoteAt,quotePrice:price.toFixed(),entryAverage:fill.toFixed(),
   adverseEntrySlippageBps:fill.div(price).minus(1).mul(sign*10000).toFixed(),
   note:'Observed quote-to-fill difference includes market movement and latency; already reflected in actual PnL.'}};
}

// The split is chronological by whole entry windows, not random rows. Purge
// trades whose labels were not available before the test feature window began.
export function chronologicalSplit(rows,{minRows=100,minDays=30}={}){
 if(!Array.isArray(rows)||!Number.isInteger(minRows)||minRows<2||!Number.isInteger(minDays)||minDays<1)fail('SPLIT_CONFIG');
 const eligible=rows.filter(r=>r.outcome&&!r.outcome.exceedsPlannedHolding).sort((a,b)=>a.entryFillAt-b.entryFillAt||a.key.localeCompare(b.key));
 const groups=new Set(eligible.map(r=>[r.mode,r.ruleVersion,r.direction,r.strategyFingerprint].join('|')));
 if(groups.size>1||new Set(rows.map(r=>r.key)).size!==rows.length)fail('SPLIT_COHORT_MIXED_OR_DUPLICATE');
 const cut=eligible.length>1?eligible[Math.min(eligible.length-1,Math.floor(eligible.length*.8))].featureAsOf+1:null;
 const test=cut===null?[]:eligible.filter(r=>r.featureAsOf+1>=cut),testStart=test.length?Math.min(...test.map(r=>r.featureStartAt)):null;
 const before=cut===null?[]:eligible.filter(r=>r.featureAsOf+1<cut),train=before.filter(r=>r.outcome.closedAt<testStart),
  purged=before.filter(r=>r.outcome.closedAt>=testStart),days=eligible.length?(eligible.at(-1).entryFillAt-eligible[0].entryFillAt)/86400000:0;
 const reasons=[];
 if(eligible.length<minRows)reasons.push('INSUFFICIENT_SAME_COHORT_TRADES');
 if(days<minDays)reasons.push('INSUFFICIENT_TIME_SPAN');
 if(!train.length||!test.length)reasons.push('EMPTY_PURGED_PARTITION');
 if(new Set(train.map(r=>r.outcome.profitable)).size<2)reasons.push('TRAINING_LABELS_LACK_BOTH_CLASSES');
 return {status:reasons.length?'insufficient_evidence':'dataset_available_for_research',reasons,
  minimumRows:minRows,minimumDays:minDays,sampleDays:days,eligibleRows:eligible.length,cutoff:cut,
  trainKeys:train.map(r=>r.key),testKeys:test.map(r=>r.key),purgedKeys:purged.map(r=>r.key),
  modelTrained:false,predictionsAvailable:false,promotionAuthorized:false,
  note:'80/20 is an unoptimized research partition. Minimums reuse existing preliminary evidence criteria; they do not certify model adequacy or profit. Long-held/outage-affected rows stay in accounting but are excluded from this normal-execution training slice.'};
}

export function summarizeLearning(rows,exclusions,asOf,thresholds){
 const grouped=new Map();
 for(const row of rows){const key=[row.mode,row.ruleVersion,row.direction,row.strategyFingerprint].join('|');if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
 const cohorts=[...grouped.entries()].map(([key,items])=>({key,mode:items[0].mode,ruleVersion:items[0].ruleVersion,
  direction:items[0].direction,strategyFingerprint:items[0].strategyFingerprint,rows:items.length,
  closed:items.filter(r=>r.outcome).length,open:items.filter(r=>!r.outcome).length,
  netRealizedUsdt:sum(items.filter(r=>r.outcome).map(r=>r.outcome.netRealizedUsdt)).toFixed(),
  estimatedNetRewardRiskMedian:median(items.map(r=>r.features.netRewardRisk)),
  belowOneNetRewardRisk:items.filter(r=>decimal(r.features.netRewardRisk).lt(1)).length,
  exceedsPlannedHolding:items.filter(r=>r.outcome?.exceedsPlannedHolding).length,
  split:chronologicalSplit(items,{minRows:thresholds.minClosedTrades,minDays:thresholds.minCalendarDays})}));
 return {schema:LEARNING_SCHEMA,asOf,source:'recorded-demo-entry-evidence-and-freqtrade-fills',rows,exclusions,cohorts,
  modelTrained:false,predictionsAvailable:false,promotionAuthorized:false,
  notes:['Actual engine profit_abs is the outcome; fees are not subtracted twice. Payoff estimates are not realized returns.',
   'Only filled v9/v10 strategy entries with verified pre-entry evidence are eligible. No hypothetical trades or labels for skipped signals are synthesized.',
   'This is a selected-trade dataset, not all market opportunities. It cannot establish the result of changing entry policy or swapping models.',
   'Feature values are recomputed now from immutable entry-time snapshots. They were not model predictions recorded before the trade.']};
}

export async function collectLearningEvidence({root,histories,asOf,thresholds}){
 const rows=[],exclusions=[],inputHashes=[];
 for(const mode of ['demo','demo-futures']){
  const local=join(root,'local',mode),records=await journalRead(join(local,'orders.jsonl')),
   history=histories[mode],seen=new Set();
  if(!Array.isArray(history))fail('HISTORY_REQUIRED');
  for(const trade of history){
   if(seen.has(trade.trade_id))fail('DUPLICATE_TRADE');seen.add(trade.trade_id);
   const tag=trade.enter_tag;
   if(!/^codex-[a-f0-9]{32}$/.test(tag??'')){exclusions.push({mode,tradeId:trade.trade_id,reason:'LEARNING_UNTRACKED_ENTRY'});continue;}
   try{
    const files=[],read=async relative=>{const buffer=await readFile(join(local,relative));files.push({path:mode+'/'+relative,sha256:hash(buffer)});return JSON.parse(buffer);};
    const plan=await read('entry-plans/'+tag+'.json');
    if(plan.purpose!=='strategy'||!['atr15m-forward-v9','atr15m-forward-v10'].includes(plan.ruleVersion))fail('UNSUPPORTED_STRATEGY');
    if(!/^[a-f0-9-]{36}$/i.test(plan.snapshotId??''))fail('SNAPSHOT_IDENTITY');
    const base='runs/'+plan.snapshotId;
    const [snapshot,quote,cost,version]=await Promise.all(['snapshot','execution-quote','cost-check','version'].map(s=>read(base+'.'+s+'.json')));
    const row=learningRow({mode,trade,plan,snapshot,quote,cost,version,records,asOf});rows.push(row);
    inputHashes.push({key:row.key,tradeSha256:hash(JSON.stringify(canonical(trade))),files:files.sort((a,b)=>a.path.localeCompare(b.path)),
     journalEntrySha256:hash(JSON.stringify(records.filter(r=>r.id===tag.slice(6))))});
   }catch(error){exclusions.push({mode,tradeId:trade.trade_id,reason:/^LEARNING_[A-Z_]+$/.test(error.message)?error.message:
    error.code==='ENOENT'?'LEARNING_ENTRY_EVIDENCE_MISSING':'LEARNING_ENTRY_EVIDENCE_INVALID'});}
  }
 }
 return {...summarizeLearning(rows,exclusions,asOf,thresholds),inputHashes};
}

export function learningMarkdown(r){
 const n=v=>v==null?'—':Number(v).toFixed(4),esc=v=>String(v).replace(/[|\r\n]/g,' ');
 return ['# 真實 Demo 成交學習資料','',`資料時間：${r.asOf}。來源：進場前快照與實際 Freqtrade Demo 成交。`,
  '',`已建立 ${r.rows.length} 筆資料；排除 ${r.exclusions.length} 筆。這份成交資料尚未用於重新訓練；此匯出器不產生預測。預訓練模型的即時預測另見 local/model-research/report.md。`,
  '', '| 模式 | 版本 | 方向 | 原碼雜湊 | 已平／未平 | 實際淨利 | 預估淨報酬風險比中位數 | 比值低於 1 | 資料狀態 |',
  '|---|---|---|---|---:|---:|---:|---:|---|',
  ...r.cohorts.map(c=>'| '+[c.mode,c.ruleVersion,c.direction,c.strategyFingerprint.slice(0,12),c.closed+'/'+c.open,n(c.netRealizedUsdt),n(c.estimatedNetRewardRiskMedian),c.belowOneNetRewardRisk,c.split.status].map(esc).join(' | ')+' |'),
  '', '預估淨報酬風險比 =（原停利距離 − 進場時預估來回成本）／（原停損距離 + 同項成本）。不含提前退出、滑價變化或移動停利的路徑，因此它不是獲利預測。低於 1 表示原目標淨利小於預計停損損失；不能直接把被篩掉的虧損算成新策略收益。',
  '', '模型資料按模式、版本、方向與進場原碼雜湊分組，保留未平倉資料但不給收益標籤。時間切分會排除橫跨測試特徵窗口的訓練交易；超出原持倉時限的交易另標示並保留於帳務。',
  '', '## 逐筆證據','', '| 模式／交易 | 版本 | 淨報酬風險比估計 | 二結果模型打平勝率估計 | 報價到成交不利偏移 bps | 實際淨利 |',
  '|---|---|---:|---:|---:|---:|',...r.rows.map(t=>'| '+[t.key,t.ruleVersion,n(t.estimatedPayoff.netRewardRisk),t.estimatedPayoff.twoOutcomeBreakEvenWinRate===null?'無正目標淨利':n(Number(t.estimatedPayoff.twoOutcomeBreakEvenWinRate)*100)+'%',n(t.execution.adverseEntrySlippageBps),t.outcome?n(t.outcome.netRealizedUsdt):'未平倉'].map(esc).join(' | ')+' |'),
  '', '完整特徵、原始來源 SHA256、排除原因及时间切分在同資料夾的 learning.json；learning.jsonl 每行一筆，features 與 outcome 分欄。特徵欄不含成交後價格、浮盈高點或退出原因。這是已成交的選擇樣本，不能據此聲稱新進場規則、其他模型或正式資金已驗證獲利。',''].join('\n');
}
