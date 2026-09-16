const time=value=>Number.isFinite(value)?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const seconds=value=>Math.max(0,Math.ceil(value/1000));
export function timingView({data,market,preview,error,elapsedMs=0}){
 if(preview)return {status:'展示資料 · 不代表即時時間',tone:'muted',clock:'示例',lastClose:'示例',delay:'示例',nextCandle:'示例',nextResearch:'未執行',expiry:'無有效訊號'};
 const ms=data?.timing?.candleMs??(market?.timeframe==='5m'?300000:900000);
 const t=data?.timing,age=Number.isFinite(elapsedMs)&&elapsedMs>=0?elapsedMs:Infinity;
 const good=!!t&&!t.clockError&&Number.isFinite(t.serverNow)&&age<=45000&&!error;
 const current=good?t.serverNow+age:NaN,last=market?.candles?.at(-1),close=Number.isSafeInteger(last?.closeTime)?last.closeTime+1:NaN;
 const boundary=Math.floor(current/ms)*ms,missing=Number.isFinite(close)&&Number.isFinite(boundary)?boundary-close:NaN;
 const phase=t?.stopped?'已暫停':t?.watchRunning?(t.decisionIntervalMs===60000?'每 1 分鐘判斷 · 5m K 線':'排程運行中'):'排程未啟動';
 const next=Date.parse(t?.nextResearchAt),expiry=Date.parse(t?.latestResearch?.signalExpiresAt);
 const failed=['failed','aborted'].includes(t?.stage);
 const validSignal=good&&!t.stopped&&t.watchRunning&&!failed&&!t.latestResearch?.consumed&&expiry>current;
 return {status:good?(missing<0?'K 線時間異常 · '+phase:missing>0?'K 線落後 · '+phase:!Number.isFinite(close)?'等待 K 線 · '+phase:'時間已校驗 · '+phase):'時間資料不可用或已過期 · '+phase,
  tone:!good||!Number.isFinite(missing)||missing!==0?'warning':'ok',
  clock:good?'交易所－本機 '+Math.round(t.clock.offsetMs)+' ms（±'+Math.ceil(t.clock.uncertaintyMs)+' ms）':t?.clockError??'等待校驗',
  lastClose:time(close),delay:!good||!Number.isFinite(missing)?'無法核對':missing<0?'K 線時間異常':missing>0?'落後 '+seconds(missing)+' 秒':'無缺 K · 收盤後 '+seconds(current-close)+' 秒',
  nextCandle:good?time(boundary+ms)+'（'+seconds(boundary+ms-current)+' 秒）':'—',
  nextResearch:t?.stopped?'已暫停，不會啟動':!t?.watchRunning?'排程未啟動':!good?'等待時間校驗':Number.isFinite(next)&&next>current?time(next)+'（'+seconds(next-current)+' 秒）':['waiting_candle','waiting_decision'].includes(t?.stage)?'等待排程更新':'本輪執行中',
  expiry:validSignal?time(expiry)+'（剩 '+seconds(expiry-current)+' 秒）':t?.stopped?'已暫停 · 不可進場':failed?'本輪失敗 · 不可進場':t?.latestResearch?.consumed?'本輪已處理':!good?'無法核對':Number.isFinite(expiry)?'已過期／未運行':'尚無研究訊號'};
}
