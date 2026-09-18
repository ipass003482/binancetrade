// One domain store owns transport, request races and refresh state.
export class DashboardStore extends EventTarget {
 constructor({fetchImpl=fetch}={}) {super();this.fetch=(...args)=>fetchImpl(...args);this.state={mode:'dry-run',pair:'BTC/USDT',preview:false,loading:false,data:null,market:null,error:null,marketError:null,tradingDisabled:true};this.version=0;}
 publish(update) {Object.assign(this.state,update);this.dispatchEvent(new Event('change'));}
 async refresh(update={}) {
  const nextMode=update.mode??this.state.mode,basePair=(update.pair??this.state.pair).split(':')[0];
  update={...update,pair:basePair+(nextMode==='demo-futures'?':USDT':'')};
  this.controller?.abort();const version=++this.version;this.controller=new AbortController();
  this.publish({...update,loading:true,error:null,marketError:null,data:null,market:null});
  if(this.state.preview){this.publish({...previewData(this.state.mode,this.state.pair),tradingDisabled:true,loading:false});return;}
  const {mode,pair}=this.state;
  const get=async path=>{const response=await this.fetch(path,{signal:this.controller.signal});if(!response.ok)throw new Error('READ_FAILED');return response.json();};
  const apply=value=>{if(version===this.version)this.publish(value);};
  await Promise.all([
   get('/api/dashboard?mode='+encodeURIComponent(mode)).then(data=>apply({data,tradingDisabled:data?.tradingDisabled===true,dataReceivedMono:performance.now()})).catch(e=>{if(e.name!=='AbortError')apply({error:'工作區資料讀取失敗，請確認 UI 服務仍在執行。'});}),
   get('/api/market?mode='+encodeURIComponent(mode)+'&pair='+encodeURIComponent(pair)).then(market=>apply({market})).catch(e=>{if(e.name!=='AbortError')apply({marketError:'行情目前無法取得，請稍後更新。'});})
  ]);
  const allowed=this.state.data?.policy?.pairs;
  if(version===this.version&&allowed?.length&&!allowed.includes(this.state.pair))return this.refresh({pair:allowed[0]});
  apply({loading:false});
 }
}
export function previewData(mode,pair) {
 const end=Date.UTC(2026,8,1,8),base=({BTC:68200,ETH:3450,SOL:145,BNB:580})[pair.split('/')[0]],scale=base/68200;
 const moves=[0,100,70,230,380,210,70,145,320,410,470,295,140,225,345,180,35,-100,-175,-60,85,150,65,285,390,535,480,600,690,590,720,675];
 const candles=moves.map((move,i)=>{const open=base+(i?moves[i-1]:-60)*scale,close=base+move*scale;return {open,close,high:Math.max(open,close)+(45+(i%4)*17)*scale,low:Math.min(open,close)-(33+(i%5)*13)*scale,volume:40+(i*37%120),openTime:end-(32-i)*900000,closeTime:end-(31-i)*900000-1};});
 const result={data:{mode,observedAt:new Date(end).toISOString(),tradingDisabled:true,account:{total:1002.62,positions:[{pair:'BTC/USDT',stake:25,openRate:68120.5,profit:.38},{pair:'ETH/USDT',stake:25,openRate:3421.8,profit:-.12}]},summary:{netRealizedUsdt:'2.36',closedTrades:2},trades:[{id:1,pair:'BTC/USDT',stake:25,profit:1.80,closedAt:new Date(end-3600000).toISOString(),exitReason:'roi'},{id:2,pair:'ETH/USDT',stake:25,profit:.56,closedAt:new Date(end-7200000).toISOString(),exitReason:'exit_signal'}],historyError:null,setup:{configured:false,credentialsPresent:false},engineError:null,stopped:false,cycle:{stage:'completed'},policy:{pairs:['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT'],maxStakeUsdt:'50',maxExposureUsdt:'50',maxDailyLossUsdt:'20',maxOpenTrades:2},decisions:[
  {action:'hold',pair:'BTC/USDT',at:new Date(end).toISOString(),reason:'動能偏多，但目前曝險已達上限。維持持倉，等待更好的進場條件。'},
  {action:'buy',pair:'ETH/USDT',at:new Date(end-900000).toISOString(),reason:'短線量價同步上升，提議以 25 USDT 建立現貨部位。'},
  {action:'hold',pair:'BTC/USDT',at:new Date(end-1800000).toISOString(),reason:'觀察突破後的價格延續性，保留風險預算。'}]},market:{pair,bid:candles.at(-1).close,ask:candles.at(-1).close+.01,spreadBps:.01/candles.at(-1).close*10000,candles,mode,source:'展示數據',fetchedAt:new Date(end).toISOString()}};
 if(mode==='demo-futures'){
  result.data.policy={...result.data.policy,pairs:result.data.policy.pairs.map(p=>p+':USDT'),marginMode:'isolated',maxLeverage:3,maxNotionalUsdt:'150',maxTotalNotionalUsdt:'150'};
  for(const list of [result.data.account.positions,result.data.trades])list.forEach((t,i)=>Object.assign(t,{pair:t.pair+':USDT',isShort:i===1,leverage:3,notional:75}));
  result.data.decisions.forEach(d=>{d.pair+=':USDT';if(d.action==='buy'){d.action='open-short';d.reason='固定示例：提議以 25 USDT 保證金、3 倍槓桿開空；非即時訊號。';}});
 }
 return result;
}
