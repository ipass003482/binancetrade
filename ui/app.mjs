import { DashboardStore } from './store.mjs';
const $=id=>document.getElementById(id),store=new DashboardStore();
const number=(v,d=2)=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const signed=v=>v===null||v===undefined?'—':(Number(v)>0?'+':'')+number(v);
const clock=v=>v?new Date(v).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const dateTime=v=>v?new Date(v).toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const text=(id,value)=>{$(id).textContent=value;};
const element=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
const actions=['buy','sell','hold','open-long','open-short','close-long','close-short'];
const positionLabel=p=>p.pair+(p.leverage!==undefined?' · '+(p.isShort?'空':'多')+' '+p.leverage+'×':'');
let selected=31,marketIdentity=null;
function drawChart(){
 const market=store.state.market,candles=market?.candles,target=$('chart');target.replaceChildren();
 if(!candles?.length){target.append(element('span','',store.state.marketError??'WAITING FOR MARKET DATA'));target.setAttribute('aria-label','行情尚未取得');$('candle').disabled=true;for(const id of ['candle-time','candle-open','candle-high','candle-low','candle-close','candle-index'])text(id,'—');return;}
 const identity=market.mode+market.pair+market.fetchedAt;
 if(identity!==marketIdentity){marketIdentity=identity;selected=candles.length-1;}
 selected=Math.max(0,Math.min(selected,candles.length-1));$('candle').disabled=false;$('candle').max=String(candles.length-1);$('candle').value=String(selected);
 const chosen=candles[selected];text('candle-time',dateTime(chosen.openTime));$('candle-time').dateTime=new Date(chosen.openTime).toISOString();
 for(const [id,key]of [['candle-open','open'],['candle-high','high'],['candle-low','low'],['candle-close','close']])text(id,number(chosen[key]));
 text('candle-index',String(selected+1).padStart(2,'0')+' / '+candles.length);$('candle').setAttribute('aria-valuetext',`${dateTime(chosen.openTime)}，收盤 ${number(chosen.close)} USDT`);
 const width=Math.max(target.clientWidth,280),height=Math.max(target.clientHeight,180),ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
 const make=(tag,attrs,label,parent=svg)=>{const e=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))e.setAttribute(key,String(value));if(label!==undefined)e.textContent=label;parent.append(e);return e;};
 const low=Math.min(...candles.map(c=>Number(c.low))),high=Math.max(...candles.map(c=>Number(c.high))),range=high-low||1;
 const right=width-49,left=width<500?8:15,top=18,bottom=height-61,step=(right-left)/(candles.length-1),y=v=>top+(high-Number(v))/range*(bottom-top),x=i=>left+i*step;
 const defs=make('defs',{}),gradient=make('linearGradient',{id:'trace-fill',x1:0,x2:0,y1:0,y2:1},undefined,defs);make('stop',{offset:'0%','stop-color':'#6f9bd0','stop-opacity':'.12'},undefined,gradient);make('stop',{offset:'100%','stop-color':'#6f9bd0','stop-opacity':'0'},undefined,gradient);
 for(let i=0;i<4;i++){const yy=top+i*(bottom-top)/3;make('line',{x1:0,x2:right+4,y1:yy,y2:yy,stroke:'#e9edf4','stroke-width':'.6','stroke-dasharray':i===3?'0':'2 6'});make('text',{x:width-2,y:yy+3,'text-anchor':'end'},number(high-range*i/3,0));}
 const points=candles.map((c,i)=>[x(i),y(c.close)]),path=points.map((p,i)=>(i?'L':'M')+p.join(' ')).join(' ');
 make('path',{d:path+` L ${right} ${bottom+10} L ${left} ${bottom+10} Z`,fill:'url(#trace-fill)'});
 make('path',{d:path,fill:'none',stroke:'#83b2ac','stroke-width':width<500?1.2:1.6,'stroke-linejoin':'round',opacity:.8});
 const volumeMax=Math.max(...candles.map(c=>Number(c.volume)),1),cw=Math.min(step*.28,6);
 candles.forEach((c,i)=>{const xx=x(i),color=Number(c.close)>=Number(c.open)?'#6f9bd0':'#c3a6b4';make('line',{x1:xx,x2:xx,y1:y(c.high),y2:y(c.low),stroke:color,'stroke-width':.8,opacity:.75});make('rect',{x:xx-cw/2,y:Math.min(y(c.open),y(c.close)),width:cw,height:Math.max(Math.abs(y(c.close)-y(c.open)),1.5),fill:color,opacity:i===selected?1:.65});const vh=Number(c.volume)/volumeMax*22;make('rect',{x:xx-Math.max(cw,2)/2,y:height-27-vh,width:Math.max(cw,2),height:vh,fill:'#a4b8cf',opacity:i===selected?.75:.18});});
 const xx=x(selected),yy=y(chosen.close);make('line',{x1:xx,x2:xx,y1:7,y2:height-23,stroke:'#6f9bd0','stroke-width':.8,'stroke-dasharray':'3 4',opacity:.85});make('circle',{cx:xx,cy:yy,r:4,fill:'#ffffff',stroke:'#6f9bd0','stroke-width':1.5});
 const tickIndices=width<500?[0,15,31]:[0,6,12,18,24,31];
 for(const i of tickIndices.filter(i=>i<candles.length))make('text',{x:x(i),y:height-5,'text-anchor':i===0?'start':i===candles.length-1?'end':'middle'},clock(candles[i].openTime));
 target.append(svg);target.setAttribute('aria-label',`${market.pair} 15 分鐘行情，${candles.length} 根已收盤 K 線。線為收盤軌跡，直線為高低價，底部為成交量。選取 ${dateTime(chosen.openTime)}，開盤 ${number(chosen.open)}、最高 ${number(chosen.high)}、最低 ${number(chosen.low)}、收盤 ${number(chosen.close)}。`);
}
function render(){
 const {data,market,preview,mode,loading,error,marketError}=store.state;
 const futures=mode==='demo-futures',pairs=['BTC','ETH','SOL','BNB'].map(p=>p+'/USDT'+(futures?':USDT':''));
 if([...$('pair').options].map(o=>o.value).join()!==pairs.join()){$('pair').replaceChildren(...pairs.map(p=>{const o=element('option','',p);o.value=p;return o;}));}
 $('pair').value=store.state.pair;
 text('research-market-label',futures?'Binance Demo 永續 · 公開資料':'Binance Spot · 公開資料');
 text('exposure-label',futures?'保證金使用':'曝險使用');text('exposure-limit-label',futures?'總保證金上限':'總曝險上限');text('stake-label',futures?'單筆保證金上限':'單筆投入上限');
 $('futures-limits').hidden=!futures;text('notional-limit','最高 '+(data?.policy?.maxLeverage??3)+'× · 單筆 '+(data?.policy?.maxNotionalUsdt??150)+' / 合計 '+(data?.policy?.maxTotalNotionalUsdt??150)+' USDT');
 document.body.classList.toggle('is-preview',preview);$('refresh').disabled=loading;text('refresh',loading?'…':'↻');$('preview').setAttribute('aria-pressed',String(preview));text('preview',preview?'離開展示 ↗':'開啟展示 ↗');
 text('source-label',preview?'EXHIBITION / SAMPLE DATA':futures?'DEMO FUTURES / ISOLATED / MAX 3×':mode==='demo'?'BINANCE DEMO / VIRTUAL':'DRY-RUN / LOCAL');
 text('notice',preview?'展示中的行情、績效與提案皆為範例。':error??(data?.engineError?'帳戶尚未連線或驗證未通過；公開行情可獨立查看。':data?'唯讀監看 · 每 30 秒更新':'正在讀取工作區…'));
 text('balance',number(data?.account?.total));text('balance-note',preview?'示例帳戶 · 非實際資金':data?.account?'引擎回傳帳戶總值':'等待引擎連線');
 const pnl=data?.summary?.netRealizedUsdt;text('pnl',signed(pnl));$('pnl').className=pnl===null||pnl===undefined?'':Number(pnl)>=0?'positive':'negative';
 const positions=data?.account?.positions??[],max=data?.policy?.maxExposureUsdt??'50',used=data?.account?positions.reduce((sum,p)=>sum+Number(p.stake??0),0):null,ratio=used===null?0:Math.max(0,Math.min(100,used/Number(max)*100));
 text('position-count',(data?.account?positions.length:'—')+' / '+(data?.policy?.maxOpenTrades??2));text('exposure',max+' USDT');text('exposure-used',number(used));text('exposure-max',max);$('risk-fill').style.width=ratio+'%';$('risk-meter').setAttribute('aria-valuenow',String(ratio));$('risk-meter').setAttribute('aria-valuetext',used===null?'尚未取得持倉':number(used)+' / '+max+' USDT');
 const stages={idle:'待命',completed:'已完成',failed:'執行失敗',research:'研究中',analyze:'分析中',execute:'執行中',collecting:'研究中',analyzing:'分析中',executing:'執行中'};
 text('cycle-state',stages[data?.cycle?.stage]??'待命');text('cycle-note',preview?'示例流程 · 不代表模型正在運作':'最後記錄狀態 · 非即時活動');
 text('engine-badge',preview?'示例持倉':data?.account?'引擎已連線':'未連線');text('position-source',preview?'固定示例 · 非實際持倉':futures?'逐倉永續合約 · 投入欄為保證金；方向與槓桿列於交易對旁。':'現貨 · 當前引擎回傳的持倉');
 const body=$('positions-body');body.replaceChildren();
 if(!positions.length){const row=element('tr'),cell=element('td','empty',data?.account?'目前沒有未平倉部位':'引擎尚未連線，無法確認目前持倉');cell.colSpan=4;row.append(cell);body.append(row);}
 for(const p of positions){const row=element('tr');row.append(element('td','',positionLabel(p)),element('td','',number(p.stake)),element('td','',number(p.openRate)),element('td',Number(p.profit)>=0?'positive':'negative',signed(p.profit)));body.append(row);}
 const first=data?.decisions?.[0],action=actions.includes(first?.action)?first.action:'standby';
 text('proposal-action',action.toUpperCase());$('proposal-action').dataset.action=action;text('proposal-pair',first?.pair??'等待提案');text('proposal-time',clock(first?.at));text('proposal-reason',first?.reason??'研究完成後，在這裡查看 Codex 的判斷與理由。');
 const list=$('decision-list'),expanded=new Set([...list.querySelectorAll('details[open]')].map(e=>e.dataset.key));list.replaceChildren();
 for(const d of data?.decisions??[]){const a=actions.includes(d.action)?d.action:'hold',row=element('details','decision'),heading=element('summary'),t=element('time','',dateTime(d.at));row.dataset.key=d.at+d.pair;row.open=expanded.has(row.dataset.key);t.dateTime=d.at;heading.append(element('span','action '+a,a.toUpperCase()),element('span','decision-pair',d.pair),t);row.append(heading,element('p','',d.reason));list.append(row);}
 if(!data?.decisions?.length)list.append(element('p','empty','尚無模型提案。執行研究週期後，紀錄會顯示在這裡。'));
 text('stake-limit',(data?.policy?.maxStakeUsdt??'50')+' USDT');text('loss-limit',(data?.policy?.maxDailyLossUsdt??'20')+' USDT');text('stop-status',data?(data.stopped?'進場已暫停':'未設定暫停標記'):'等待狀態');
 text('market-price',number(market?.bid));text('ask-value',number(market?.ask));text('spread-value',number(market?.spreadBps));text('market-source',preview?'示例行情 / 非即時':futures?'Binance Demo 永續':mode==='demo'?'Binance Demo':'Binance Spot');text('market-time',marketError?'更新失敗':market?'取得於 '+clock(market.fetchedAt):'等待行情');
 text('updated',preview?'FIXED SAMPLE / 2026.09.01':data?'工作區更新 '+dateTime(data.observedAt):'等待資料');drawChart();renderConnection();renderTrades();drawAnalytics();
}
store.addEventListener('change',render);
$('refresh').addEventListener('click',()=>store.refresh());$('mode').addEventListener('change',()=>store.refresh({mode:$('mode').value}));$('pair').addEventListener('change',()=>store.refresh({pair:$('pair').value}));
$('preview').addEventListener('click',()=>{const preview=!store.state.preview;history.replaceState(null,'',preview?'/?preview=1':'/');store.refresh({preview});});
$('candle').addEventListener('input',()=>{selected=Number($('candle').value);drawChart();drawAnalytics();});
for(const b of document.querySelectorAll('[data-drawer]'))b.addEventListener('click',()=>{const name=b.dataset.drawer;for(const kind of ['positions','trades','decisions','risk'])$('drawer-'+kind).hidden=kind!==name;text('drawer-index','工作區 / '+({positions:'持倉',trades:'交易紀錄',decisions:'研究筆記',risk:'風控'}[name]));$('drawer').showModal();});
$('close-drawer').addEventListener('click',()=>$('drawer').close());
for(const button of document.querySelectorAll('.help-button'))button.addEventListener('click',()=>$('help').showModal());$('close-help').addEventListener('click',()=>$('help').close());
new ResizeObserver(()=>{drawChart();drawAnalytics();}).observe($('chart'));
store.refresh({preview:new URLSearchParams(location.search).get('preview')==='1'});
setInterval(()=>{if(!document.hidden&&!store.state.preview&&!store.state.loading&&!$('drawer').open)store.refresh();},30000);


function renderConnection(){
 const {data,preview,loading,mode,error}=store.state,suffix=mode!=='dry-run'?' --mode '+mode:'';
 text('setup-command','node src/cli.mjs setup'+suffix);text('engine-command','node src/cli.mjs engine'+suffix);text('cycle-command','node src/cli.mjs cycle'+suffix);$('credential-step').hidden=mode==='dry-run';text('credential-command','powershell.exe -NoProfile -File scripts/configure-demo.ps1 -Mode '+(mode==='demo-futures'?'demo-futures':'demo'));
 text('setup-status',preview?'展示中':data?.setup?.configured?'設定檔已建立':data?'尚未建立':'尚未檢查');
 text('credential-status',preview?'展示中':data?.setup?.credentialsPresent?'已找到加密金鑰檔':'尚未設定');
 text('engine-status',preview?'展示中':data?.account?'引擎身分已驗證':data?'尚未連線':'尚未檢查');
 text('sync-status',preview?'展示中':data?.account?(data.historyError?'帳戶已讀取，交易紀錄待確認':'帳戶及紀錄已同步'):'等待引擎連線');
 text('header-connection',preview?'設定交易連線':data?.account?'引擎已連線':'連接工作區');
 $('check-connection').disabled=loading;text('check-connection',loading?'正在檢查…':'檢查連線');
 const result=preview?'目前為展示模式。檢查連線會切換到所選環境，讀取本地引擎。':error??(loading?'正在檢查所選環境…':data?.account?(data.historyError?'帳戶與持倉已連上；交易歷史本次讀取失敗，請稍後重試。':'已驗證引擎身分，帳戶、持倉與交易紀錄已讀取。'):mode!=='dry-run'&&data?.setup?.configured&&!data?.setup?.credentialsPresent?'工作區已建立。請先在本機設定 Demo 金鑰，再啟動 Freqtrade。':data?.setup?.configured?'工作區設定已存在。請啟動上方對應的 Freqtrade 指令，再檢查一次。':'請先在專案目錄執行工作區設定，再啟動引擎。');
 text('connection-result',result);
 for(const dot of document.querySelectorAll('.status-dot'))dot.style.background=!preview&&data?.account?'#63a18d':'#b6bfcc';
 text('flow-market',store.state.market?(preview?'示例行情':'已讀取行情'):'等待資料');text('flow-proposal',data?.decisions?.length?(preview?'示例提案':'已有紀錄'):'尚無提案');text('flow-engine',preview?'示例狀態':data?.account?'已連線':'尚未連線');
 const list=$('activity-list');list.replaceChildren();
 for(const d of (data?.decisions??[]).slice(0,5)){const row=element('div','activity-item');row.append(element('time','',clock(d.at)),element('strong','',String(d.action).toUpperCase()),element('span','',d.pair+' · '+d.reason));row.title=d.reason;list.append(row);}
 if(!data?.decisions?.length)list.append(element('p','empty','還沒有研究紀錄，完成一次研究週期後會顯示在這裡。'));
}
function renderTrades(){
 const {data,preview}=store.state,body=$('trades-body');body.replaceChildren();
 for(const t of data?.trades??[]){const row=element('tr');row.append(element('td','',positionLabel(t)),element('td','',dateTime(t.closedAt)),element('td',Number(t.profit)>=0?'positive':'negative',signed(t.profit)),element('td','',t.exitReason??'—'));body.append(row);}
 if(!data?.trades?.length){const row=element('tr'),cell=element('td','empty',data?.trades?'目前沒有已平倉交易。':data?.historyError?'交易紀錄讀取失敗，帳戶狀態仍可查看。':'引擎尚未連線，無法讀取交易紀錄。');cell.colSpan=4;row.append(cell);body.append(row);}
 text('history-note',preview?'固定示例 · 非實際成交':data?.trades?'本次從 Freqtrade 讀取的最近 50 筆已平倉交易。':'等待取得引擎紀錄。');
}
function svgSurface(id,width,height){
 const target=$(id);target.replaceChildren();const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
 const add=(tag,attrs,label,parent=svg)=>{const e=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))e.setAttribute(key,String(value));if(label!==undefined)e.textContent=label;parent.append(e);return e;};target.append(svg);return {target,svg,add};
}
function drawAnalytics(){
 const candles=store.state.market?.candles;
 const flow=svgSurface('flow-chart',280,220),fa=flow.add,cx=140,cy=107,r=73;
 fa('circle',{cx,cy,r,fill:'none',stroke:'#e9edf5','stroke-dasharray':'3 6'});fa('circle',{cx,cy,r:52,fill:'#fafbfe',stroke:'#f1f3f9'});
 const nodes=[{x:140,y:34,label:'研究',color:'#91b4d8'},{x:213,y:107,label:'Codex',color:'#b39acf'},{x:140,y:180,label:'風控',color:'#d3b180'},{x:67,y:107,label:'執行',color:'#8eb6a6'}];
 nodes.forEach((n,i)=>{const next=nodes[(i+1)%4];fa('path',{d:`M ${n.x} ${n.y} Q ${cx} ${cy} ${next.x} ${next.y}`,fill:'none',stroke:n.color,'stroke-width':1.8,opacity:.65});fa('circle',{cx:n.x,cy:n.y,r:13,fill:n.color,opacity:.12});fa('circle',{cx:n.x,cy:n.y,r:5,fill:n.color});fa('text',{x:n.x,y:n.y+(i===0?-19:i===2?28:29),'text-anchor':'middle',fill:n.color},n.label);});
 fa('text',{x:cx,y:cy-2,'text-anchor':'middle','font-size':10,fill:'#8d9db4'},'WORKSPACE');fa('text',{x:cx,y:cy+15,'text-anchor':'middle','font-size':7},'4 RESPONSIBILITIES');
 if(!candles?.length){for(const id of ['landscape','dimensions-chart'])$(id).replaceChildren(element('span','empty','載入行情後顯示'));for(const id of ['range-change','range-amplitude','range-volume'])text(id,'—');return;}
 const closes=candles.map(c=>Number(c.close)),lo=Math.min(...candles.map(c=>Number(c.low))),hi=Math.max(...candles.map(c=>Number(c.high))),range=hi-lo||1;
 const change=(closes.at(-1)/Number(candles[0].open)-1)*100;text('range-change',(change>0?'+':'')+number(change)+'%');$('range-change').className=change>=0?'positive':'negative';text('range-amplitude',number((hi-lo)/lo*100)+'%');text('range-volume',number(candles.reduce((sum,c)=>sum+Number(c.volume),0)/candles.length));
 const {target,add}=svgSurface('landscape',760,238),layers=12,windowSize=21;
 const defs=add('defs',{}),gradient=add('linearGradient',{id:'ridge-tone',x1:0,y1:0,x2:0,y2:1},undefined,defs);add('stop',{offset:0,'stop-color':'#dce8ef','stop-opacity':.52},undefined,gradient);add('stop',{offset:1,'stop-color':'#ffffff','stop-opacity':.7},undefined,gradient);
 // Each ridge is a real overlapping 21-candle window, normalized to the same price range.
 for(let layer=layers-1;layer>=0;layer--){const values=closes.slice(layer,layer+windowSize),offset=layer*9,base=206-layer*6,points=values.map((v,i)=>({x:28+i*27+offset,y:base-(v-lo)/range*120}));
 const path=points.map((pt,i)=>(i?'L':'M')+pt.x+' '+pt.y).join(' ');add('path',{d:path+` L ${points.at(-1).x} ${base} L ${points[0].x} ${base} Z`,fill:'url(#ridge-tone)',stroke:'none'});add('path',{d:path,fill:'none',stroke:layer===0?'#719aab':'#a1b4c1','stroke-width':layer===0?1.8:1,opacity:layer===0?1:.7});
 if(layer===0){const localIndex=Math.min(selected,values.length-1),pt=points[localIndex];if(selected<windowSize)add('circle',{cx:pt.x,cy:pt.y,r:3.5,fill:'#b681a7',stroke:'#fff','stroke-width':1.5});}}
 add('line',{x1:28,y1:209,x2:703,y2:137,stroke:'#e3e9f0','stroke-width':.8});add('text',{x:28,y:230},'較早');add('text',{x:684,y:174},'較新');add('text',{x:575,y:35,'font-size':8},'21-CANDLE WINDOWS');target.setAttribute('aria-label',`12 條重疊的 21 根收盤價曲線，統一價格範圍 ${number(lo)} 到 ${number(hi)}，以時間位移排列，非機率分布。`);
 const dim=svgSurface('dimensions-chart',470,215),da=dim.add,keys=['open','high','low','close','volume'],labels=['開盤','最高','最低','收盤','成交量'],last=candles.slice(-8),colors=['#b6c7df','#bdcce5','#afcdd0','#94bfc0','#a4c8ba','#bea7cc','#aa94c6','#c998b5'];
 const mins=keys.map(key=>Math.min(...last.map(c=>Number(c[key])))),maxs=keys.map(key=>Math.max(...last.map(c=>Number(c[key]))));
 keys.forEach((key,i)=>{const x=32+i*101;da('line',{x1:x,x2:x,y1:27,y2:174,stroke:'#e5ebf3'});for(const yy of [27,76,125,174])da('line',{x1:x-3,x2:x+3,y1:yy,y2:yy,stroke:'#d4dfed'});da('text',{x,y:199,'text-anchor':'middle'},labels[i]);});
 last.forEach((c,i)=>{const points=keys.map((key,j)=>({x:32+j*101,y:174-(Number(c[key])-mins[j])/(maxs[j]-mins[j]||1)*147}));da('path',{d:points.map((pt,j)=>(j?'L':'M')+pt.x+' '+pt.y).join(' '),fill:'none',stroke:colors[i],'stroke-width':i===7?2:1,opacity:i===7?.9:.5});if(i===7)points.forEach(pt=>da('circle',{cx:pt.x,cy:pt.y,r:3,fill:colors[i],stroke:'#fff','stroke-width':1.5}));});dim.target.setAttribute('aria-label','最近 8 根 K 線的開、高、低、收與成交量平行座標圖。各軸分別依這 8 根的最小最大值正規化；不能用來比較不同欄位的絕對大小。');
}
$('check-connection').addEventListener('click',()=>{history.replaceState(null,'','/');store.refresh({preview:false});});
for(const b of document.querySelectorAll('[data-view]'))b.addEventListener('click',()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
for(const b of document.querySelectorAll('[data-focus]'))b.addEventListener('click',()=>document.querySelector('.market-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
