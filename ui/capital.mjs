const $=id=>document.getElementById(id);
const names={demo:'現貨','demo-futures':'合約'};
const groups={aligned:'同向',opposed:'反向',mixed:'混合',neutral:'中性',unavailable:'資料缺失／過期',unattributed:'無進場前紀錄'};
const chains={all:'全市場',Ethereum:'Ethereum',Solana:'Solana',BSC:'BNB Chain',Near:'Near'};
const fmt=(v,d=4)=>v==null?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const time=v=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
function cell(row,text,tone){const td=document.createElement('td');td.textContent=text;if(tone!=null)td.className=Number(tone)>0?'today-gain':Number(tone)<0?'today-loss':'';row.append(td);}
function row(body,values){const tr=document.createElement('tr');for(const v of values)cell(tr,Array.isArray(v)?v[0]:v,Array.isArray(v)?v[1]:null);body.append(tr);}
function render(data){
 const ready=data.status==='observing';
 $('capital-status').textContent=ready?'Demo 同步觀察中 · 不新增進場門檻':'觀察資料暫不可用 · 原交易流程不受影響';
 $('capital-time').textContent='更新 '+time(data.observedAt)+' · 觀察起點 '+time(data.startedAt);
 const sources=$('capital-sources');sources.replaceChildren();
 for(const name of ['all','Ethereum','Solana','BSC','Near']){
  const s=data.sources?.find(s=>s.chain===name);
  row(sources,[chains[name],s?fmt(s.supply,2):'—',s?[fmt(s.change1dPct,3)+'%',s.change1dPct]:'—',s?[fmt(s.change7dPct,3)+'%',s.change7dPct]:'—',time(s?.sourceAt),time(s?.observedAt),s?.usable?'可作日級背景':'缺失／過期，視為中性']);
 }
 const body=$('capital-cohorts');body.replaceChildren();
 for(const result of data.results??[])for(const g of result.groups)row(body,[names[g.mode],groups[g.group],g.closed,g.open,g.complete?g.wins+' / '+g.losses:'待核對',fmt(g.winRatePct,1)+(g.winRatePct==null?'':'%'),[fmt(g.netUsdt),g.netUsdt],[fmt(g.averageNetUsdt),g.averageNetUsdt],fmt(g.closedTradeDrawdownUsdt)]);
 if(!body.children.length)row(body,['等待完整 Demo 成交紀錄']);
 const tradesSeen=(data.results??[]).flatMap(r=>r.rows);
 const attributed=tradesSeen.filter(t=>!['unattributed','unavailable'].includes(t.group)).length;
 $('capital-errors').textContent=data.historyStale?'成交統計尚未取得或已過期，已清除舊數字；訂單流觀察繼續。':Object.keys(data.historyErrors??{}).length?'部分帳戶紀錄暫不可用，未顯示該帳戶統計。':
  '成交核對 '+time(data.lastResultAt)+' · 有效背景 '+attributed+' / '+tradesSeen.length+' 筆'+(data.historyPending?' · 更新成交中':'')+'。僅納入觀察起點之後的真實 Demo 交易，淨損益含引擎已記錄成本。';
 const trades=$('capital-trades');trades.replaceChildren();
 for(const t of (data.results??[]).flatMap(r=>r.rows).sort((a,b)=>b.openedAt-a.openedAt))row(trades,[names[t.mode]+' #'+t.id,t.pair,t.direction==='short'?'做空':'做多',time(t.openedAt),groups[t.group],time(t.observedAt),t.isOpen?'持倉中':'已平倉',[fmt(t.netUsdt),t.netUsdt]]);
 if(!trades.children.length)row(trades,['等待觀察啟用後的新成交；舊交易不回填']);
 const candidates=$('capital-candidates');candidates.replaceChildren();
 for(const o of [...(data.observations??[])].sort((a,b)=>b.advisoryRank-a.advisoryRank||a.pair.localeCompare(b.pair)))row(candidates,[names[o.mode],o.pair,o.direction==='short'?'做空':'做多',o.flowValid?(o.flowEligible?'方向支持':'未同向'):'資料無效',chains[o.chain],groups[o.group],o.advisoryRank>0?'+1':String(o.advisoryRank),time(o.sampledAt)]);
 if(!candidates.children.length)row(candidates,['等待新訂單流觀察']);
}
let busy=false;
async function refresh(){if(busy)return;busy=true;
 try{const r=await fetch('/api/capital-flow',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();render(await r.json());}
 catch{render({status:'unavailable',sources:[],results:[],observations:[]});}
 finally{busy=false;}}
$('capital-refresh').addEventListener('click',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden)refresh();},15000);refresh();
