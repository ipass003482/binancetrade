// Offline, conditional-on-entry sensitivity study. Never imports a trading client.
export const variants=[
 {name:'fixed_roi',trailing:false},
 {name:'trailing_08_04',trailing:true},
 {name:'trailing_time_120m',trailing:true,timeMinutes:120},
 {name:'trailing_time_240m',trailing:true,timeMinutes:240}
];
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
export function validateBars(bars,start,end){
 if(!Array.isArray(bars)||bars.length!==Math.floor((end-start)/60000)||!bars.length)throw Error('REPLAY_COVERAGE_INCOMPLETE');
 for(const [i,b] of bars.entries())if(b.time!==start+i*60000||![b.open,b.high,b.low,b.close].every(positive)||
  b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||b.low>b.high)throw Error('REPLAY_INVALID_BARS');
}
export function replayExit(trade,bars,variant,{path='low-first',slippageBps=0}={}){
 if(!['low-first','high-first'].includes(path)||![0,5,10].includes(slippageBps))throw Error('REPLAY_INVALID_SCENARIO');
 const opened=trade.open_timestamp,entry=trade.open_rate,stake=trade.stake_amount;
 const feeIn=trade.fee_open,feeOut=trade.fee_close;
 if(trade.is_short!==false||trade.trading_mode!=='spot'||!positive(opened)||!positive(entry)||!positive(stake)||
  ![feeIn,feeOut].every(v=>typeof v==='number'&&v>=0&&v<.1))throw Error('REPLAY_UNSUPPORTED_TRADE');
 const start=Math.ceil(opened/60000)*60000,end=Math.floor((opened+360*60000)/60000)*60000;
 validateBars(bars,start,end);
 const amount=stake/entry,basis=stake*(1+feeIn),net=p=>amount*p*(1-feeOut)-basis;
 let stop=entry*.98,active=false;
 const finish=(price,reason,time)=>{const fill=price*(1-slippageBps/10000);return {
  tradeId:trade.trade_id,variant:variant.name,path,slippageBps,reason,time,
  holdingMinutes:(time-opened)/60000,price:fill,netUsdt:net(fill),netPct:net(fill)/basis*100};};
 for(const b of bars){
  const age=(b.time-opened)/60000,roi=age>=360?.005:age>=120?.015:.03;
  const target=basis*(1+roi)/(amount*(1-feeOut));
  // Gaps cross protective levels at the first observed open, never an invented fill at the stop.
  if(b.open<=stop)return finish(b.open,active?'trailing_gap':'stop_gap',b.time);
  if(b.open>=target)return finish(b.open,'roi_gap',b.time);
  if(variant.timeMinutes&&age>=variant.timeMinutes)return finish(b.open,'time_limit',b.time);
  const points=path==='high-first'?[b.open,b.high,b.low,b.close]:[b.open,b.low,b.high,b.close];
  for(const price of points){
   if(price<=stop)return finish(stop,active?'trailing_stop':'stop',b.time);
   if(price>=target)return finish(target,'roi',b.time);
   if(variant.trailing&&net(price)/basis>.008){active=true;stop=Math.max(stop,price*.996);}
  }
 }
 const last=bars.at(-1);return finish(last.close,'horizon_mark',last.time+60000);
}
export function compareExits(trades,datasets){
 if(!trades.length)return {summary:[],results:[]};
 const results=[];
 for(const t of trades)for(const v of variants)for(const path of ['low-first','high-first'])for(const slippageBps of [0,5,10])
  results.push(replayExit(t,datasets[t.trade_id],v,{path,slippageBps}));
 const summary=[];
 for(const v of variants)for(const slippageBps of [0,5,10]){
  const rows=results.filter(r=>r.variant===v.name&&r.slippageBps===slippageBps);
  const bounds=trades.map(t=>rows.filter(r=>r.tradeId===t.trade_id).map(r=>r.netUsdt));
  summary.push({variant:v.name,slippageBps,trades:trades.length,
   sampledPathNetMinUsdt:bounds.reduce((s,a)=>s+Math.min(...a),0),sampledPathNetMaxUsdt:bounds.reduce((s,a)=>s+Math.max(...a),0)});
 }
 return {summary,results};
}
