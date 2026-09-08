import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { readJson,writeJson,journalRead,exists } from './io.mjs';
import { safeError } from './health.mjs';
import { writeFile } from 'node:fs/promises';
function money(v){try{if(v===null||v===undefined||v==='')return null;const d=new Decimal(v);return d.isFinite()?d:null;}catch{return null;}}
export function summarizeTrades(trades){
 const closed=trades.filter(t=>t.is_open===false).sort((a,b)=>(a.close_timestamp??0)-(b.close_timestamp??0));
 const usable=closed.filter(t=>money(t.profit_abs)!==null),fees={},missingFees=[];
 let pnl=new Decimal(0),peak=new Decimal(0),drawdown=new Decimal(0),wins=0;
 for(const t of usable){
  const value=money(t.profit_abs);pnl=pnl.plus(value);if(value.gt(0))wins++;
  peak=Decimal.max(peak,pnl);drawdown=Decimal.max(drawdown,peak.minus(pnl));
 }
 for(const t of trades)for(const side of ['open','close']){
  if(side==='close'&&t.is_open!==false)continue;
  const value=money(t['fee_'+side+'_cost']),currency=t['fee_'+side+'_currency'];
  if(value===null||!currency){missingFees.push({tradeId:t.trade_id,side});continue;}
  fees[currency]=new Decimal(fees[currency]??0).plus(value).toFixed();
 }
 const complete=usable.length===closed.length;
 return {closedTrades:closed.length,openTrades:trades.filter(t=>t.is_open===true).length,
  pnlComplete:complete,netRealizedUsdt:complete?pnl.toFixed():null,knownNetRealizedUsdt:pnl.toFixed(),
  winRate:complete&&closed.length?wins/closed.length:null,
  closedTradeDrawdownUsdt:complete?drawdown.toFixed():null,feesByCurrency:fees,missingFees,
  notes:['PnL is reported by Freqtrade after its fee accounting; do not subtract fees again.',
   'Drawdown covers closed-trade cumulative PnL only; it is not account equity drawdown.',
   'Amounts in different fee currencies are not summed or converted.']};
}
export function decisionRows(proposals,records,trades){
 const latest=new Map(records.map(r=>[r.id,r]));
 return proposals.map(p=>{
  const id=createHash('sha256').update(p.snapshotId).digest('hex').slice(0,32),entry=latest.get(id);
  const matched=trades.filter(t=>t.enter_tag==='codex-'+id || (p.action==='sell'&&entry?.tradeId===t.trade_id));
  return {snapshotId:p.snapshotId,action:p.action,pair:p.pair,reason:p.reason,
   evidenceIds:p.evidenceIds,submission:entry?.status??'not_submitted',tradeIds:matched.map(t=>t.trade_id),
   outcomes:matched.map(t=>({tradeId:t.trade_id,isOpen:t.is_open,netRealizedUsdt:t.is_open?null:t.profit_abs,
    exitReason:t.exit_reason??null,orders:(t.orders??[]).map(o=>({side:o.ft_order_side,status:o.status,
     open:o.is_open,filled:o.filled,remaining:o.remaining,average:o.average??o.price}))}))};
 });
}
function cell(value){return String(value??'—').replace(/[\r\n]/g,' ').replace(/[\\|\[\]()<>!*_`]/g,'\\$&');}
export function markdown(report){
 const s=report.summary;
 return ['# Binance trade 交易與決策報表','',
  '模式：'+report.mode+'｜產生時間：'+report.generatedAt,
  '資料：'+(report.historyFresh?'本次從引擎讀取':'歷史快取或無交易資料')+'｜觀測時間：'+(report.observedAt??'無'),
  '',...report.warnings.map(w=>'- '+cell(w)),'',
  '## 績效（USDT）','',
  s?'已平倉：'+s.closedTrades+'；未平倉：'+s.openTrades+'；已實現淨損益：'+(s.netRealizedUsdt??'資料不完整'):'無可用交易歷史。',
  s?'勝率：'+(s.winRate===null?'無法計算':(s.winRate*100).toFixed(2)+'%')+'；已平倉損益回撤：'+(s.closedTradeDrawdownUsdt??'資料不完整'):'',
  s?'費用依幣別：'+cell(JSON.stringify(s.feesByCurrency))+'；缺少費用欄位：'+s.missingFees.length:'',
  '損益已包含引擎的費用計算，不再重複扣費。此回撤不是帳戶權益回撤。','',
  '## 決策追蹤','',
  '| 動作 | 商品 | 送出狀態 | 交易 ID | 理由 |','|---|---|---|---|---|',
  ...report.decisions.map(d=>'| '+[d.action,d.pair,d.submission,d.tradeIds.join(', '),d.reason].map(cell).join(' | ')+' |'),
  '', '逐筆成交、退出原因、費用和證據 ID 請看同名 JSON。未送出可能是風控拒絕或流程中斷，請對照執行紀錄。',
  '', '## 最近執行紀錄','',
  ...report.cycles.map(c=>'- '+cell(c.at)+' '+cell(c.status)+' '+cell(c.code??c.result?.status??'')),
  '', '此報表描述觀察到的結果，不代表策略已經通過績效驗證。',''].join('\n');
}
export async function buildReport(local,client,mode){
 const cache=join(local,'trade-history.json');let historyFresh=false,history=null;const warnings=[];
 try{
  const trades=await client.history(),account=await client.snapshot();
  history={mode,observedAt:new Date().toISOString(),trades,openTrades:account.trades};
  await writeJson(cache,history);historyFresh=true;
 }catch(e){
  warnings.push('引擎資料無法完整更新：'+safeError(e));
  if(await exists(cache)){history=await readJson(cache);if(history.mode!==mode)throw new Error('REPORT_MODE_MISMATCH');}
 }
 if(!historyFresh)warnings.push('此報表不能用來確認目前持倉或判斷可以再次下單。');
 const dir=join(local,'runs'),proposals=[],cycles=[];
 if(await exists(dir))for(const file of (await readdir(dir)).sort()){
  if(!file.endsWith('.proposal.json')&&!file.endsWith('.outcome.json'))continue;
  try{const value=await readJson(join(dir,file));(file.endsWith('.proposal.json')?proposals:cycles).push(value);}
  catch{warnings.push('無法讀取執行檔案：'+file);}
 }
 const records=await journalRead(join(local,'orders.jsonl')),trades=history?.trades??[];
 // Open status contains current PnL; keep it separate from realized trade history.
 const report={mode,generatedAt:new Date().toISOString(),historyFresh,observedAt:history?.observedAt??null,warnings,
  summary:history?summarizeTrades(trades):null,decisions:decisionRows(proposals,records,trades),
  trades,openPositions:history?.openTrades??[],cycles:cycles.sort((a,b)=>String(a.at).localeCompare(String(b.at))).slice(-100)};
 const stem=join(local,'reports',report.generatedAt.replace(/[:.]/g,'-'));
 await writeJson(stem+'.json',report);await writeFile(stem+'.md',markdown(report),'utf8');
 return {mode,json:stem+'.json',markdown:stem+'.md',summary:report.summary,historyFresh,warnings};
}
