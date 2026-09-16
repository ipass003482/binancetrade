// Local saved-history analysis only. No trading client, account login or network calls.
import { readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ROOT } from './paths.mjs';
import { readJson,writeJson,journalRead } from './io.mjs';
import { loadPolicy } from './config.mjs';
import { captureStrategyVersion,readTradeVersions } from './strategy-version.mjs';
import { evaluatePerformance } from './performance.mjs';

export const EvaluationThresholds=z.object({
 minClosedTrades:z.number().int().min(2).max(100000),
 minCalendarDays:z.number().int().min(1).max(10000),
 minProfitFactor:z.number().finite().min(1).max(100),
 extraExecutionCostBpsPerSide:z.number().finite().min(0).max(1000)
}).strict();
export async function loadEvaluationThresholds(){return EvaluationThresholds.parse(await readJson(join(ROOT,'config/evaluation.json')));}
const cell=v=>String(v??'無法計算').replace(/[\r\n]/g,' ').replace(/[\\|\[\]()<>!*_`]/g,'\\$&');
const labels={insufficient_evidence:'證據不足',criteria_not_met:'未達研究門檻',preliminary_only:'僅符合初步研究門檻'};
const metricLabels={closedTrades:'已平倉筆數',netRealizedUsdt:'已實現淨損益（USDT）',expectancyUsdt:'平均每筆淨損益（USDT）',
 profitFactor:'獲利因子（總獲利／總虧損）',winRate:'勝率（比例）',netWithoutBestTradeUsdt:'扣除最佳一筆後淨損益（USDT）',
 closedTradeDrawdownUsdt:'已平倉累計損益回撤（USDT）',maxConsecutiveLosses:'最長連續虧損筆數',calendarDays:'有成交的首尾日期跨度（UTC 日）'};
const checkLabels={complete_input:'資料完整',closed_trades:'同版本已平倉筆數',calendar_days:'同版本首尾成交日期跨度',
 profit_factor:'同版本獲利因子',positive_net:'同版本淨利為正',positive_net_without_best_trade:'同版本扣除最佳一筆後仍獲利'};
const display=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))
 ?Number(value).toLocaleString('en-US',{maximumFractionDigits:6,useGrouping:false}):cell(value);
export function performanceMarkdown(p){
 if(!p)return '尚無績效驗收資料。';
 return [
  '目前版本評估：**'+cell(labels[p.assessment.status]??p.assessment.status)+'**。此判定不會開啟交易，也不是穩定獲利證明。',
  '', '以下總表與成本壓力測試包含所有歷史版本，依引擎淨損益，不重複扣原有費用；手動平倉、不同設定的結果可能混在總表，請看分組。',
  '', '| 指標 | 值 |','|---|---:|',
  ...Object.entries(metricLabels).map(([k,label])=>'| '+label+' | '+display(p.summary[k])+' |'),
  '', '表格顯示最多六位小數；完整精度保留在 JSON。',
  '', '目前版本的研究門檻：','', '| 條件 | 目前值 | 要求 | 結果 |','|---|---:|---:|---|',
  ...p.assessment.checks.map(c=>'| '+[checkLabels[c.name]??c.name,display(c.actual),cell(c.required),c.passed?'符合':'未符合'].join(' | ')+' |'),
  '', '目前版本：'+cell(p.currentVersion?.fingerprint??'尚無可比對版本')+'；'+cell(labels[p.currentVersion?.assessment?.status]??'尚無同版本證據'),
  '', '## 分組檢查','',
  '不同版本、槓桿、方向與投入金額不能直接合併成目前策略的績效。完整分組、每天結果與成本壓力情境保留在 JSON。',
  ...['version','direction','leverage','pair'].flatMap(kind=>[
   '', '### '+({version:'進場版本',direction:'方向',leverage:'槓桿',pair:'商品'})[kind],
   '', '| 分組 | 已平倉筆數 | 淨損益 USDT | 獲利因子 |','|---|---:|---:|---:|',
   ...p.cohorts[kind].map(g=>'| '+[cell(({unversioned:'未記錄版本',long:'多',short:'空'})[g.key]??g.key),g.summary.closedTrades,display(g.summary.netRealizedUsdt),display(g.summary.profitFactor)].join(' | ')+' |')]),
  '', '## 額外成交成本壓力','',
  '只從可核對的成交金額額外扣除指定 bps，屬假設情境，不是實際費率或已實現損益。',
  '', '```json',JSON.stringify(p.executionCostStress,null,2),'```',
  '', '## 資料限制','',...p.limitations.map(v=>'- '+cell(v)),
  '', '未提供連續帳戶權益與資金流資料，因此不以已平倉損益回撤冒充帳戶百分比回撤；沒有樣本外測試也不會標示已驗證。'
 ].join('\n');
}

export async function evaluateSavedHistory({local,mode,input=join(local,'trade-history.json')}){
 const bytes=await readFile(input),history=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
 if(history.mode!==mode)throw Error('EVALUATION_MODE_MISMATCH');
 if(!Array.isArray(history.trades)||!Number.isFinite(Date.parse(history.observedAt))||Date.parse(history.observedAt)>Date.now())throw Error('EVALUATION_HISTORY_INVALID');
 const records=await journalRead(join(local,'orders.jsonl'));
 const attribution=await readTradeVersions(local,history.trades,records,mode);
 const current=await captureStrategyVersion({policy:await loadPolicy(mode),engine:history.strategyVersion?.engine});
 const thresholds=await loadEvaluationThresholds();
 const performance=evaluatePerformance({trades:history.trades,mode,observedAt:history.observedAt,
  currentVersion:current.fingerprint,tradeVersions:attribution.versions,thresholds});
 const generatedAt=new Date().toISOString(),directory=join(local,'evaluations',generatedAt.replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
 const evaluatorSource=await readFile(join(ROOT,'src/performance.mjs'));
 const result={schemaVersion:1,mode,generatedAt,observedAt:history.observedAt,readOnly:true,historyFresh:false,
  source:{path:resolve(input),sha256:createHash('sha256').update(bytes).digest('hex'),copy:'input-history.json'},
  evaluator:{copy:'performance-source.mjs',sha256:createHash('sha256').update(evaluatorSource).digest('hex'),node:process.version},
  thresholds,currentVersion:current,tradeVersions:attribution.versions,attributionWarnings:attribution.warnings,performance,
  notes:['Saved history is descriptive evidence at observedAt, not a fresh account/position check.',
   'Current source is compared with the engine settings captured in the input, when available; restart and verify the engine before a new experiment.',
   'Historical unversioned trades remain unversioned. No retrospective holdout label is assigned.']};
 await writeJson(join(directory,'evaluation.json'),result);
 await writeFile(join(directory,'input-history.json'),bytes,{flag:'wx'});
 await writeFile(join(directory,'performance-source.mjs'),evaluatorSource,{flag:'wx'});
 await writeFile(join(directory,'evaluation.md'),[
  '# Binance trade 績效驗收','', '模式：'+mode+'｜歷史觀測：'+history.observedAt+'｜產生：'+generatedAt,
  '', '僅讀取已保存的歷史，不連交易所、不下單。輸入 SHA-256：'+result.source.sha256,
  '', performanceMarkdown(performance),'','研究門檻：'+JSON.stringify(thresholds),'',...result.notes.map(n=>'- '+n),''
 ].join('\n'),{flag:'wx'});
 return {mode,json:join(directory,'evaluation.json'),markdown:join(directory,'evaluation.md'),observedAt:history.observedAt,
  assessment:performance.assessment,currentVersionAssessment:performance.currentVersion.assessment,summary:performance.summary};
}
