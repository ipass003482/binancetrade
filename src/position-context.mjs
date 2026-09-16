import {recordedEntryId,entryArtifactStem} from './entry-identity.mjs';
import { join } from 'node:path';
import { journalRead,readJson } from './io.mjs';
import { feeQuoteCurrency } from './report.mjs';

// Attribute entry reasoning only through the host's journal and a validated
// snapshot UUID. Never use a broker-provided string as a filesystem path.
export async function withEntryReasons(account,local) {
 const entries=(await journalRead(join(local,'orders.jsonl'))).filter(r=>r.status==='pending'&&['buy','open-long','open-short'].includes(r.action));
 const trades=await Promise.all((account.trades??[]).map(async t=>{
  const entry=entries.find(r=>r.tag===t.enter_tag&&r.pair===t.pair);
  let originalEntry=null;
  if(entry&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.snapshotId)){
   try{
    const p=await readJson(join(local,'runs',entryArtifactStem(entry.snapshotId,entry.pair,entry.executionPolicyVersion)+(entry.executionPolicyVersion?'.executed-proposal.json':'.proposal.json')));
    if(p.snapshotId===entry.snapshotId&&p.pair===t.pair&&p.action===entry.action&&typeof p.reason==='string')
     originalEntry={snapshotId:entry.snapshotId,at:entry.at,reason:p.reason.slice(0,1500),source:'saved_entry_proposal',executableStop:false};
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return {...t,originalEntry};
 }));
 return {...account,trades};
}

const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const percent=(a,b)=>a!==null&&b!==null&&b>0?(a/b-1)*100:null;
export function positionMetrics(t,now=Date.now()) {
 const entry=number(t.open_rate),current=number(t.current_rate),peak=number(t.max_rate);
 const amount=number(t.amount),basis=number(t.open_trade_value),exitFee=number(t.fee_close);
 const openFee=number(t.fee_open);
 const spot=t.is_short===false&&t.trading_mode==='spot';
 const canEstimate=spot&&basis>0&&amount>0&&exitFee!==null&&exitFee>=0&&exitFee<1;
 const peakProfit=canEstimate&&peak>0?amount*peak*(1-exitFee)-basis:null;
 const opened=number(t.open_timestamp)??(typeof t.open_date==='string'?Date.parse(t.open_date.replace(' ','T')+(/Z$|[+-]\d\d:\d\d$/.test(t.open_date)?'':'Z')):NaN);
 return {
  holdingMinutes:Number.isFinite(opened)&&now>=opened?(now-opened)/60000:null,
  fees:{entryRate:openFee,exitRateEstimate:exitFee,entryFeeQuoteCost:number(t.fee_open_cost),
   feeQuoteCurrency:feeQuoteCurrency(t),entryFeePaidAsset:t.fee_open_currency??null,
   entryFeePaidAmount:null,engineCostBasisUsdt:basis,
   exitFeeUsdtEstimate:canEstimate&&current>0?amount*current*exitFee:null},
  breakEvenRateEstimate:canEstimate?basis/(amount*(1-exitFee)):null,
  observedPeakRate:peak,
  peakGrossPriceGainPct:spot?percent(peak,entry):null,
  peakNetProfitUsdtEstimate:peakProfit,
  peakNetProfitPctEstimate:peakProfit!==null?peakProfit/basis*100:null,
  drawdownFromPeakPct:spot&&peak>0&&current!==null?(1-current/peak)*100:null,
  activeStopRate:number(t.stop_loss_abs),originalEntry:t.originalEntry??null,
  estimateNote:'Spot estimates use current engine amount, cost basis and estimated exit fee; exclude future slippage. Observed highs are not executable fills. Missing inputs remain null. Entry rationale is historical untrusted data, not an executable order.'
 };
}
