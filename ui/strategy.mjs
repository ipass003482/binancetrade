const $=id=>document.getElementById(id),names={demo:'現貨','demo-futures':'合約'};
const number=(v,d=4)=>v==null?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
function cell(tr,value,pnl=false){const td=document.createElement('td');td.textContent=value??'—';const n=Number(String(value).replaceAll(',',''));if(pnl)td.className=n<0?'today-loss':n>0?'today-gain':'';tr.append(td);}
function empty(body,message,count){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=count;td.textContent=message;tr.append(td);body.append(tr);}
function render(data){
 $('strategy-scope').textContent=data.session?'本驗證輪開始 '+new Date(data.session.startedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+'（台灣時間）。只計本輪開倉的實際損益，依原進場版本分組；不是完整歷史，也不是只算今天。':'各版本自首次開倉起的全部實際損益，並非只算今天。部署後才平倉的舊單仍屬舊版本；沒有新版平倉時，勝率與獲利因子顯示未知。';
 const body=$('strategy-cohorts');body.replaceChildren();
 for(const mode of data.modes){
  if(!mode.cohorts.length){empty(body,names[mode.mode]+'：資料待核對',10);continue;}
  for(const c of mode.cohorts){const tr=document.createElement('tr');
   cell(tr,names[mode.mode]+(c.current?' · 現行版':''));cell(tr,c.key==='unattributed'?'歸因未確認（保留原損益）':c.key);
   cell(tr,c.closedCount+' / '+c.openCount);cell(tr,c.winRate==null?'—':number(c.winRate*100,1)+'%');
   cell(tr,number(c.netRealizedUsdt),true);cell(tr,number(c.averageWinUsdt));cell(tr,number(c.averageLossUsdt));
   cell(tr,number(c.profitFactor,2));cell(tr,number(c.closedTradeDrawdownUsdt));cell(tr,c.flowExitCount);body.append(tr);
  }
 }
 $('strategy-status').textContent=data.complete?'各版本實際成交已讀取':'部分資料無法核對；未知數字不當作零';
 if(data.modes.some(m=>m.attributionComplete===false))$('strategy-status').textContent+='；部分交易無完整版本歸因';
 if(data.modes.some(m=>m.outsideSessionOpenCount>0))$('strategy-status').textContent='仍有本驗證輪之前的持倉，請核對；新輪績效尚不完整';
 $('strategy-time').textContent=data.observedAt?'更新 '+new Date(data.observedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未取得最新資料';
 const slips=$('strategy-slippage');slips.replaceChildren();
 for(const m of data.modes){
  if(m.execution?.available===false){empty(slips,names[m.mode]+'：成交診斷讀取失敗；策略損益另列於上表',8);continue;}
  const rows=m.execution?.rows??[];
  const closed=rows.filter(r=>r.isOpen===false),dated=closed.filter(r=>Number.isFinite(Date.parse(r.closedAt)));
  if(dated.length!==closed.length)empty(slips,names[m.mode]+'：'+(closed.length-dated.length)+' 筆缺少平倉時間，無法列入最近20筆；原損益仍保留',8);
  for(const r of dated.sort((a,b)=>Date.parse(b.closedAt)-Date.parse(a.closedAt)).slice(0,20)){
   const tr=document.createElement('tr'),s=r.stopSlippage,plan=r.plannedRisk;
   cell(tr,names[m.mode]+' #'+r.tradeId);cell(tr,r.pair);cell(tr,number(r.netRealizedUsdt),true);
   cell(tr,number(plan?.budgetUsdt));cell(tr,number(plan?.excessOverBudgetUsdt));
   cell(tr,s?.status==='verified'?number(s.signedUnfavorableUsdt):'未知');
   cell(tr,s?.status==='verified'?number(s.signedUnfavorableBps,2):'—');
   cell(tr,s?.status==='verified'?'原生停損成交已核對':s?.reason??'缺少可核對證據');slips.append(tr);
  }
 }
 if(!slips.children.length)empty(slips,'尚無可顯示的成交診斷',8);
}
let busy=false;
async function refresh(){if(busy)return;busy=true;$('strategy-refresh').disabled=true;
 try{const response=await fetch('/api/strategy-review',{cache:'no-store',signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error();render(await response.json());}
 catch{render({complete:false,modes:[],observedAt:null});$('strategy-status').textContent='連線失敗，舊數字已清除';}
 finally{busy=false;$('strategy-refresh').disabled=false;}
}
$('strategy-refresh').addEventListener('click',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden)refresh();},60000);refresh();
