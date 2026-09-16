// Operational Demo reads plus unsigned production market data. Never sends orders.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {ROOT} from '../src/paths.mjs';
import {loadPolicy} from '../src/config.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {FreqtradeClient} from '../src/freqtrade.mjs';
import {refreshPortfolio} from '../src/portfolio-store.mjs';
import {loadEvaluationThresholds} from '../src/evaluation.mjs';
import {DEMO_RULE_VERSION} from '../src/demo-rules.mjs';
import {buildReadinessReview,collectMarketComparison} from '../src/readiness-review.mjs';
import {safeError} from '../src/health.mjs';
import {collectLearningEvidence,learningMarkdown} from '../src/learning-evidence.mjs';

const target=join(ROOT,'local','readiness'),hash=value=>createHash('sha256').update(value).digest('hex');
const fmt=value=>value==null?'資料不足':Number(value).toLocaleString('en-US',{maximumFractionDigits:6});
const esc=value=>String(value).replace(/[|\r\n]/g,' ');
function markdown(r){
 const lines=['# 每月成果與真金準備檢查','',`資料時間：${r.observedAt}；策略：${r.currentVersion}；帳務月份：台灣時間。`,
  '',`共同資金 ${fmt(r.capitalUsdt)} USDT；累積淨損益（含浮動）${fmt(r.netPnlUsdt)}；已取樣最大回撤 ${fmt(r.sampledMaxDrawdownUsdt)}。`,
  '', '## 每月已平倉成果','',
  '以下按平倉月份列出整筆交易淨損益，含既有費用／資金費。跨月浮盈未重建，因此這不是每月淨資產報酬；進行中的月份不宣告獲利驗證通過。',
  '', '| 月份 | 模式 | 類型／版本 | 平倉筆數 | 淨損益 USDT | 加回已記錄費用後 |','|---|---|---|---:|---:|---:|'];
 for(const month of r.monthlyRealized){
  for(const g of month.groups)lines.push('| '+[month.month+(!month.calendarMonthClosed?'（進行中）':!month.experimentCoversMonthStart?'（首月不完整）':''),
   g.mode,g.purpose+' / '+g.version,g.closedTrades,fmt(g.netRealizedUsdt),fmt(g.netPlusRecordedFeesUsdt)].map(esc).join(' | ')+' |');
 }
 lines.push('','加回費用欄僅用來判斷虧損是否全由費用造成，並非可實現的收益，資金費仍包含在內。',
  '', '## 同版本研究門檻','',`沿用既有 ${r.thresholds.minClosedTrades} 筆／${r.thresholds.minCalendarDays} UTC 日跨度／獲利因子 ${r.thresholds.minProfitFactor}，另看扣除最佳一筆後淨利與每側額外 ${r.thresholds.extraExecutionCostBpsPerSide} bps 成本壓力。這些是初步研究條件，達標不會自動開啟真金。`,
  '', '| 模式 | 目前版本平倉 | 首尾成交日跨度 | 淨損益 | 獲利因子 | 額外成本後假設淨利 | 狀態 |','|---|---:|---:|---:|---:|---:|---|');
 for(const [mode,v] of Object.entries(r.modeReviews)){
  const c=v.currentVersion,s=c.summary;
  lines.push('| '+[mode,s.closedTrades,s.calendarDays,fmt(s.netRealizedUsdt),fmt(s.profitFactor),fmt(c.executionCostStress.stressedNetRealizedUsdt),c.assessment.status].map(esc).join(' | ')+' |');
  for(const [variant,variantReview] of Object.entries(v.parameterVariants??{})){
   const s=variantReview.summary;lines.push('| '+[mode+' / '+variant,s.closedTrades,s.calendarDays,fmt(s.netRealizedUsdt),fmt(s.profitFactor),fmt(variantReview.executionCostStress.stressedNetRealizedUsdt),variantReview.assessment.status].map(esc).join(' | ')+' |');
  }
 }
 lines.push('', '## Demo 與正式市場公開報價','',
  '僅發送不帶帳戶憑證的 GET 行情請求；以下是 HTTP 取樣的中間價差，不是套利訊號或正式成交測試。',
  '', '| 模式 | 商品 | 狀態 | Demo − 正式中間價差 bps | 取樣完成時間差 ms |','|---|---|---|---:|---:|');
 for(const q of r.marketComparison.rows)lines.push('| '+[q.mode,q.pair,q.status,q.midDifferenceBps==null?'—':fmt(q.midDifferenceBps),q.receiptSkewMs??'—'].map(esc).join(' | ')+' |');
 lines.push('', '幣安官方說明：Demo 的價格／委託簿類似正式市場，不能假定 Demo 有效策略就會在正式市場有效。來源：[Binance Spot Demo 文件](https://github.com/binance/binance-spot-api-docs/blob/master/demo-mode/general-info.md)。',
  '', r.learning?.status==='available'?`成交學習資料：已保存 ${r.learning.rows} 筆；這份資料尚未用於重新訓練。預訓練模型觀察另見 local/model-research/report.md。`:'成交學習附加報告暫不可用；以上帳務損益仍來自完整的成交證據。',
  '', '每月淨資產報酬、真金成交證據、每月持續獲利驗證：尚未具備。現有交易與本金風控維持原設定；這份報告沒有下單或升級真金的權限。','');
 return lines.join('\n');
}

// Learning is an optional research product. Collection or publication errors
// must not replace a valid account/readiness review with an unavailable page.
export async function publishLearning({root,target,directory,histories,asOf,thresholds},
 {collect=collectLearningEvidence,read=readFile,write=writeFile,json=writeJson}={}){
 try{
  const learning=await collect({root,histories,asOf,thresholds}),sources=[];
  for(const path of ['src/learning-evidence.mjs','src/research-profile.mjs','src/timeframe.mjs','src/exchange-clock.mjs','src/strategy-version.mjs']){
   const bytes=await read(join(root,path));sources.push({path,sha256:hash(bytes),source:bytes.toString('utf8')});
  }
  learning.extractor={node:process.version,sources:sources.map(({source,...v})=>v)};
  await json(join(directory,'learning.json'),learning);
  await write(join(directory,'learning.jsonl'),learning.rows.map(r=>JSON.stringify(r)).join('\n')+(learning.rows.length?'\n':''),{flag:'wx'});
  await write(join(directory,'learning.md'),learningMarkdown(learning),{flag:'wx'});
  await write(join(directory,'learning-source.mjs'),sources[0].source,{flag:'wx'});
  await json(join(directory,'learning-extractor-sources.json'),sources);
  await json(join(target,'learning.json'),learning);
  await write(join(target,'learning.md'),learningMarkdown(learning));
  return {status:'available',asOf,rows:learning.rows.length,exclusions:learning.exclusions.length,
   report:join(directory,'learning.md'),promotionAuthorized:false};
 }catch{
  const failure={status:'unavailable',asOf,error:'LEARNING_REPORT_UNAVAILABLE',promotionAuthorized:false};
  // Best effort replaces stale optional reports, even when the error came
  // from publishing one of them. The main review records failure regardless.
  await Promise.allSettled([json(join(target,'learning.json'),failure),
   write(join(target,'learning.md'),'# 成交學習資料暫不可用\n\n'+asOf+'：'+failure.error+'。前次資料不視為本次結果；帳務成果見 latest.md。\n')]);
  return failure;
 }
}

export async function main(){try{
 const policies={},histories={};
 for(const mode of ['demo','demo-futures']){
  policies[mode]=await loadPolicy(mode);
  const client=new FreqtradeClient(policies[mode],await readJson(join(ROOT,'local',mode,'api-auth.json')));
  histories[mode]=await client.history();
 }
 const input={portfolio:await refreshPortfolio(),histories,currentVersion:DEMO_RULE_VERSION,
  thresholds:await loadEvaluationThresholds(),observedAt:new Date().toISOString()};
 const result=buildReadinessReview(input);
 result.marketComparison=await collectMarketComparison({pairsByMode:Object.fromEntries(Object.entries(policies).map(([m,p])=>[m,p.pairs]))});
 const directory=join(target,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
 const evidence=Buffer.from(JSON.stringify(input,null,2)+'\n'),source=await readFile(join(ROOT,'src/readiness-review.mjs')),
  evaluator=await readFile(join(ROOT,'src/performance.mjs'));
 result.archive={directory,inputSha256:hash(evidence),reviewSourceSha256:hash(source),performanceSourceSha256:hash(evaluator)};
 // Create the archive before optional research writes, preserving input even
 // if learning collection fails because an old entry artifact is unavailable.
 await writeJson(join(directory,'review.json'),result);
 await writeFile(join(directory,'input.json'),evidence,{flag:'wx'});
 await writeFile(join(directory,'readiness-source.mjs'),source,{flag:'wx'});
 await writeFile(join(directory,'performance-source.mjs'),evaluator,{flag:'wx'});
 result.learning=await publishLearning({root:ROOT,target,directory,histories,asOf:input.observedAt,thresholds:input.thresholds});
 await writeJson(join(directory,'review.json'),result);
 await writeFile(join(directory,'review.md'),markdown(result),{flag:'wx'});
 await writeJson(join(target,'latest.json'),result);
 await writeFile(join(target,'latest.md'),markdown(result));
 console.log(JSON.stringify({observedAt:result.observedAt,report:join(target,'latest.md'),archive:directory,
  currentVersion:result.currentVersion,monthlyProfitabilityValidated:false,
  modes:Object.fromEntries(Object.entries(result.modeReviews).map(([m,v])=>[m,{closed:v.currentVersion.summary.closedTrades,status:v.currentVersion.assessment.status}])),
  marketComparisons:result.marketComparison.rows.map(q=>({mode:q.mode,pair:q.pair,status:q.status,midDifferenceBps:q.midDifferenceBps}))},null,2));
}catch(error){
 const failure={source:'freqtrade-demo-readiness-review',observedAt:new Date().toISOString(),status:'unavailable',error:safeError(error),promotionAuthorized:false};
 await writeJson(join(target,'latest.json'),failure);
 await writeFile(join(target,'latest.md'),'# 每月成果檢查暫不可用\n\n'+failure.observedAt+'：'+failure.error+'。前次結果不視為目前狀態；未更動交易。\n');
 console.error(failure.error);process.exitCode=1;
}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
