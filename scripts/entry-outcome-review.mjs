import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {ROOT} from '../src/paths.mjs';
import {readJson,writeJson} from '../src/io.mjs';
import {buildTradeGoalReview} from './trade-goal-review.mjs';
import {evaluatePerformance} from '../src/performance.mjs';
const MODES=['demo','demo-futures'];
const hash=b=>createHash('sha256').update(b).digest('hex');
function number(v){if(!['number','string'].includes(typeof v)||String(v).length>100)return null;try{const d=new Decimal(v);return d.isFinite()&&(d.isZero()||Math.abs(d.e)<50)?d:null;}catch{return null;}}
const sum=values=>values.every(v=>v!==null)?values.reduce((s,v)=>s.plus(v),new Decimal(0)).toFixed():null;

// Accounting uses revalidated actual entry fills. Diagnostic plan comparisons
// never remove a losing trade or produce a hypothetical saved-profit estimate.
export function buildEntryOutcomeReview({input,plans={},profitReviews={}}){
 const goal=buildTradeGoalReview(input),modes={};
 for(const mode of MODES){
  const original=goal.modes[mode];
  if(!original.evidenceComplete){modes[mode]={status:'incomplete_evidence',summary:null,rows:[],warnings:original.warnings};continue;}
  const rows=[],trades=[];
  for(const proof of original.trades){
   const t=input.histories[mode].trades.find(t=>String(t.trade_id)===String(proof.tradeId));trades.push(t);
   const p=plans[mode]?.[proof.tag],g=p?.nativeEntryGuard,c=p?.entryConfirmation;
   const pending=input.journals[mode].find(r=>r.id===proof.journalId&&r.status==='pending');
   const identity=p?.tag===proof.tag&&p?.pair===proof.pair&&p?.model?.predictionSha256===proof.predictionSha256&&
    p?.model?.modelFingerprint===proof.modelFingerprint&&p?.model?.snapshotId===p?.snapshotId&&
    g?.snapshotId===p?.snapshotId&&g?.predictionSha256===proof.predictionSha256&&
    c?.predictionSha256===proof.predictionSha256&&g?.forecastClose===c?.forecastClose&&
    p?.snapshotId===pending?.snapshotId&&p?.isShort===(proof.direction==='short')&&g?.pair===proof.pair&&g?.mode===mode;
   const quote=identity?number(g.bridgeQuotePrice):null,forecast=identity?number(g.forecastClose):null,required=identity?number(g.requiredPriceSpaceBps):null;
   const move=quote?.gt(0)&&forecast?.gt(0)?forecast.minus(quote).div(quote).mul(proof.direction==='short'?-10000:10000):null;
   const costsKnown=move!==null&&required?.gt(0);
   const net=t.is_open?null:number(t.profit_abs),entry=number(t.open_rate),exit=number(t.close_rate);
   const direction=entry?.gt(0)&&exit?.gt(0)?exit.minus(entry).mul(t.is_short?-1:1).cmp(0):null;
   const fees=[number(t.fee_open_cost),number(t.fee_close_cost)];
   const feesKnown=!t.is_open&&fees.every(v=>v!==null&&v.gte(0));
   const pr=profitReviews[mode],matches=pr?.status==='observed'&&Date.parse(pr.asOf)<=Date.parse(input.observedAt)?
    (pr.strategy?.trades??[]).filter(v=>String(v.tradeId)===String(proof.tradeId)&&v.tag===proof.tag&&v.pair===proof.pair):[];
   const observation=matches.length===1?matches[0]:null,peak=number(observation?.sampledPeakNetUsdt);
   const sampled=Number.isSafeInteger(observation?.openPnlSamples)&&observation.openPnlSamples>0&&peak!==null;
   rows.push({tradeId:proof.tradeId,pair:proof.pair,direction:proof.direction,entryPolicyVersion:proof.entryPolicyVersion,
    isOpen:t.is_open,netRealizedUsdt:net?.toFixed()??null,exitReason:t.is_open?null:t.exit_reason??null,
    holdingMinutes:t.is_open?null:(t.close_timestamp-t.open_timestamp)/60000,
    engineRecordedFeesUsdt:feesKnown?sum(fees):null,
    favorableExitPriceButNetLoss:net?.lt(0)&&direction!==null?direction>0:null,
    forecastAtEntryBps:move?.toFixed()??null,requiredPriceSpaceBps:costsKnown?required.toFixed():null,
    forecastCoveredCostAndBuffer:costsKnown?move.gt(required):null,
    costEvidence:costsKnown?'entry_plan':'missing_or_inconsistent',
    openPnlSamples:sampled?observation.openPnlSamples:null,sampledPeakNetUsdt:sampled?peak.toFixed():null,
    lossAfterPositiveSample:net?.lt(0)&&sampled?peak.gt(0):null});
  }
  const summary=evaluatePerformance({trades,mode,observedAt:input.observedAt}).summary;
  const closed=rows.filter(r=>!r.isOpen),losses=closed.filter(r=>number(r.netRealizedUsdt)?.lt(0));
  const cohorts=[...new Set(rows.map(r=>r.entryPolicyVersion))].map(policy=>({entryPolicyVersion:policy,
   summary:evaluatePerformance({trades:trades.filter(t=>rows.some(r=>r.tradeId===t.trade_id&&r.entryPolicyVersion===policy)),mode,observedAt:input.observedAt}).summary}));
  modes[mode]={status:'observed',summary,cohorts,rows,
   diagnostics:{closedTrades:closed.length,engineRecordedFeesUsdt:sum(closed.map(r=>number(r.engineRecordedFeesUsdt))),
    costEvidenceKnown:rows.filter(r=>r.forecastCoveredCostAndBuffer!==null).length,
    forecastDidNotCoverCostAndBuffer:rows.filter(r=>r.forecastCoveredCostAndBuffer===false).length,
    lossesAfterPositiveSample:losses.filter(r=>r.lossAfterPositiveSample===true).length,
    lossesWithSamplesButNoPositiveSample:losses.filter(r=>r.lossAfterPositiveSample===false).length,
    lossesWithoutSamples:losses.filter(r=>r.lossAfterPositiveSample===null).length,
    favorableExitPriceButNetLoss:losses.filter(r=>r.favorableExitPriceButNetLoss===true).length}};
 }
 return {schemaVersion:1,source:'verified-demo-entry-outcome-review',observedAt:input.observedAt,goalId:goal.goalId,
  status:MODES.every(m=>modes[m].status==='observed')?'observed':'incomplete_evidence',modes,
  notes:['Actual net PnL already includes engine fee/funding accounting; fees are displayed, never subtracted twice.',
   'Entry-plan forecast/cost comparison is descriptive. It cannot prove the profit of a different strategy or select historical winners.',
   'Sampled peaks are observed API readings, not executable exit fills. Missing samples cannot mean a trade never had a profit.',
   'Different entry policies remain separate. A small sample win rate is not a reliable future win probability.'],
  executionChanged:false,promotionAuthorized:false};
}
export function outcomeMarkdown(r){
 const lines=['# Demo 進場與虧損檢查','',`資料時間：${r.observedAt}；${r.status}。`,'',
  '| 模式 | 勝／負／平 | 淨損益 USDT | 每筆平均 USDT | Profit factor | 預測未覆蓋成本及緩衝／可核對筆數 |',
  '|---|---:|---:|---:|---:|---:|'];
 for(const mode of MODES){const m=r.modes[mode],s=m.summary,d=m.diagnostics;
  lines.push(s?`| ${mode} | ${s.winningTrades}／${s.losingTrades}／${s.breakevenTrades} | ${s.netRealizedUsdt} | ${s.expectancyUsdt} | ${s.profitFactor??'不可計算'} | ${d.forecastDidNotCoverCostAndBuffer}／${d.costEvidenceKnown} |`:`| ${mode} | 資料不完整 | — | — | — | — |`);}
 for(const mode of MODES){lines.push('',`## ${mode} 逐筆`,'','| ID | 商品／方向 | 進場版本 | 淨利 USDT | 預測 bps | 成本＋緩衝 bps | 退出 |','|---|---|---|---:|---:|---:|---|');
  for(const x of r.modes[mode].rows)lines.push(`| ${x.tradeId} | ${x.pair} ${x.direction} | ${x.entryPolicyVersion} | ${x.netRealizedUsdt??'未平倉'} | ${x.forecastAtEntryBps??'未知'} | ${x.requiredPriceSpaceBps??'未知'} | ${x.exitReason??'—'} |`);}
 return lines.concat(['','實际損益未經反事實過濾；不把本可拒絕的舊虧損寫成新策略獲利。正浮盈觀測不是當時可成交的獲利，未觀測到不等於從未發生。',...r.notes.map(n=>'- '+n),'']).join('\n');
}
export async function main(argv=process.argv.slice(2)){
 if(argv.length!==2||argv[0]!=='--goal-review')throw Error('USAGE: --goal-review <archived-input.json>');
 const captured=new Map();
 const readCaptured=async p=>{const b=await readFile(p);captured.set(p,b);return JSON.parse(b.toString('utf8'));};
 const source=resolve(argv[1]),input=await readCaptured(source),plans={},profitReviews={},sourceFiles=[source];
 const initial=buildTradeGoalReview(input);
 for(const mode of MODES){plans[mode]={};
  for(const proof of initial.modes[mode].trades??[]){
   if(!/^codex-[a-f0-9]{32}$/.test(proof.tag))throw Error('INVALID_TAG');
   const p=join(ROOT,'local',mode,'entry-plans',proof.tag+'.json');
   try{plans[mode][proof.tag]=await readCaptured(p);sourceFiles.push(p);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const p=join(ROOT,'local',mode,'forward-report.json');
  try{profitReviews[mode]=(await readCaptured(p)).profitReview;sourceFiles.push(p);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 // Preserve source asOf. A later observation cannot enter an earlier audit.
 const data={input,plans,profitReviews},report=buildEntryOutcomeReview(data),base=join(ROOT,'local/entry-outcomes');
 const archive=join(base,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));await mkdir(archive,{recursive:true});
 const inputBytes=Buffer.from(JSON.stringify(data,null,2)+'\n');
 await writeFile(join(archive,'input.json'),inputBytes,{flag:'wx'});report.inputSha256=hash(inputBytes);
 const manifest=[];
 for(const [i,p]of [...sourceFiles,join(ROOT,'scripts/entry-outcome-review.mjs'),join(ROOT,'scripts/trade-goal-review.mjs'),join(ROOT,'src/entry-identity.mjs'),join(ROOT,'src/performance.mjs')].entries()){
  const b=captured.get(p)??await readFile(p),name=String(i).padStart(3,'0')+'.data';await writeFile(join(archive,name),b,{flag:'wx'});manifest.push({path:p,archive:name,sha256:hash(b)});
 }
 await writeFile(join(archive,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 report.archive=archive;await writeFile(join(archive,'review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 await writeFile(join(archive,'review.md'),outcomeMarkdown(report));await writeJson(join(base,'latest.json'),report);await writeFile(join(base,'latest.md'),outcomeMarkdown(report));
 console.log(JSON.stringify({observedAt:report.observedAt,status:report.status,modes:Object.fromEntries(MODES.map(m=>[m,{summary:report.modes[m].summary,diagnostics:report.modes[m].diagnostics}])),archive}));
 if(report.status!=='observed')process.exitCode=1;return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
