const $=id=>document.getElementById(id);
const names={'demo':'現貨','demo-futures':'合約'};
const fmt=(v,d=4)=>v==null?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const signed=v=>v==null?'—':(Number(v)>0?'+':'')+fmt(v);
const time=v=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const cell=(row,value,cls)=>{const td=document.createElement('td');td.textContent=value;if(cls)td.className=cls;row.append(td);};
const tone=v=>v==null?'':Number(v)<0?'today-loss':Number(v)>0?'today-gain':'';
const reasons={stoploss_on_exchange:'交易所停損／追蹤保護',rules_target:'達到停利目標',rules_flow_invalidated:'持續反向訊號退出',rules_time:'持倉時間到期'};
let busy=false;
function metric(id,v){$(id).textContent=signed(v);$(id).className=tone(v);}
function render(data){
 const session=data.session,scoped=Boolean(session);
 $('today-title').textContent=scoped?'本驗證輪 · 今日損益':'今天的全部損益';
 $('today-scope').textContent=scoped?'Binance Demo · 現貨＋合約 · 本驗證輪開始 '+new Date(session.startedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+'（台灣時間）· 今日統計自 '+time(data.startAt)+' 起；只計本輪開倉':'Binance Demo · 現貨＋合約 · 台北 00:00 起算 · 所有版本與驗證單';
 $('today-closed-title').textContent=scoped?'本輪今日已平倉明細':'今天全部已平倉明細';
 $('today-accounting').textContent=(scoped?'只計驗證輪開始後開倉、今日視窗內平倉的完整淨損益，輪內隔夜倉仍計入。':'已實現採今天平倉入帳的完整淨損益，含隔夜開倉。')+'已含引擎記錄費用／資金費，不重複扣費。浮動欄為範圍內持倉自開倉起的損益，尚未落袋；兩欄不是同一期間的淨值變動。';
 $('today-date').textContent=data.date+' · 台灣時間';
 $('today-status').textContent=data.complete?'已核對兩個 Demo 帳戶':'資料不完整，合計暫不顯示';
 if(data.modes.some(m=>m.outsideSessionOpenCount>0))$('today-status').textContent='仍有本驗證輪之前的持倉；請在持倉頁核對，本輪損益暫不顯示';
 $('today-updated').textContent='更新 '+time(data.observedAt)+' · 每 30 秒自動更新';
 metric('today-realized',data.realizedUsdt);metric('today-floating',data.floatingUsdt);
 $('today-count').textContent=data.closedCount==null?'—':data.closedCount+' 筆已平倉';
 $('today-open-count').textContent=data.openCount==null?'—':data.openCount+' 筆持倉';
 const summary=$('today-summary');summary.replaceChildren();
 for(const mode of data.modes){const tr=document.createElement('tr');cell(tr,names[mode.mode]);cell(tr,mode.closedCount??'—');cell(tr,mode.complete?mode.wins+' 勝 / '+mode.losses+' 負':'待核對');cell(tr,signed(mode.realizedUsdt),tone(mode.realizedUsdt));cell(tr,mode.openCount??'—');cell(tr,signed(mode.floatingUsdt),tone(mode.floatingUsdt));summary.append(tr);}
 const closed=$('today-closed'),open=$('today-open');closed.replaceChildren();open.replaceChildren();
 for(const mode of data.modes)for(const trade of mode.rows){const tr=document.createElement('tr');cell(tr,names[mode.mode]+' #'+trade.id);cell(tr,trade.pair);cell(tr,trade.direction==='short'?'做空':'做多');cell(tr,time(trade.openedAt)+(trade.carriedIn?'（隔夜倉）':''));cell(tr,trade.isOpen?'持倉中':time(trade.closedAt));cell(tr,fmt(trade.amount,6));cell(tr,fmt(trade.openRate,6));cell(tr,fmt(trade.closeRate,6));cell(tr,signed(trade.netUsdt),tone(trade.netUsdt));cell(tr,trade.isOpen?'尚未實現':reasons[trade.exitReason]??trade.exitReason??'—');(trade.isOpen?open:closed).append(tr);}
 for(const [body,message] of [[open,scoped?'本輪目前沒有持倉':'目前沒有持倉'],[closed,scoped?'本輪今日尚無已平倉交易':'今天尚無已平倉交易']])if(!body.children.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=10;td.textContent=data.complete?message:'交易紀錄待核對';tr.append(td);body.append(tr);}
}
async function refresh(){if(busy)return;busy=true;$('today-refresh').disabled=true;
 try{const response=await fetch('/api/today-pnl',{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error();render(await response.json());}
 catch{render({date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Taipei'}),complete:false,observedAt:null,modes:[],realizedUsdt:null,floatingUsdt:null,closedCount:null,openCount:null});$('today-status').textContent='連線失敗，請重新整理；舊數字已清除';$('today-updated').textContent='目前無法取得最新資料';}
 finally{busy=false;$('today-refresh').disabled=false;}}
 $('today-refresh').addEventListener('click',refresh);
 $('refresh').addEventListener('click',refresh);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 setInterval(()=>{if(!document.hidden)refresh();},30000);refresh();
