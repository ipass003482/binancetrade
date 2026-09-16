import { DashboardStore } from './store.mjs';
import { timingView } from './timing.mjs';
const $=id=>document.getElementById(id),store=new DashboardStore();
const number=(v,d=2)=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const signed=v=>v===null||v===undefined?'—':(Number(v)>0?'+':'')+number(v);
const clock=v=>v?new Date(v).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const dateTime=v=>v?new Date(v).toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
const text=(id,value)=>{$(id).textContent=value;};
const element=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
const actions=['buy','sell','hold','open-long','open-short','close-long','close-short'];
const positionLabel=p=>p.pair+(p.leverage!==undefined?' · '+(p.isShort?'空':'多')+' '+p.leverage+'×':'')+(p.sessionStatus==='outside_session'?' · 輪前持倉':p.sessionStatus==='unknown'?' · 開倉時間待核對':'');
const taipeiTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?
 new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const reasonLabels={ENTRY_DIRECTION_NOT_ALIGNED:'1 小時方向未一致',ENTRY_PRICE_NOT_BEYOND_BOTH_SMA:'價格尚未越過兩條均線',
 ENTRY_RELATIVE_VOLUME_BELOW_DEMO_MIN:'成交量低於策略門檻',ENTRY_RELATIVE_VOLUME_BELOW_ONE:'成交量低於前期均量',
 ENTRY_RELATIVE_VOLUME_UNDEFINED:'缺少可比較的成交量',BASELINE_BUFFERED_BREAKOUT_REQUIRED:'尚未突破進場價位',
 DEMO_PREVIOUS_BAR_BREAKOUT_REQUIRED:'前一根未完成突破，等待確認機會',DEMO_BREAKOUT_CONFIRMATION_FAILED:'確認 K 已收回突破門檻，取消進場',
 BASELINE_PRICE_SPACE_TOO_SMALL:'預期價格空間不足以涵蓋成本與預留',BASELINE_COSTS_REQUIRED:'交易成本資料未齊',
 DEMO_RISK_SIZE_BELOW_EXCHANGE_MINIMUM:'風險額度內的金額低於交易所最低下單額',
 DEMO_SIZE_BELOW_FREQTRADE_MINIMUM:'低於引擎最低下單額',DEMO_SIZE_NOTIONAL_LIMIT:'下單名義金額不符合限制',
 ENTRY_RATE_LIMIT:'今日開倉額度已用完',DAILY_LOSS_LIMIT:'今日虧損已達保護上限',
 POSITION_ALREADY_EXISTS:'同幣種已有持倉',POSITION_LIMIT:'持倉名額已滿',EXPOSURE_LIMIT:'曝險額度已滿',
 INSUFFICIENT_BALANCE:'可用資金不足',NOTIONAL_LIMIT:'名義倉位額度已滿',
 PORTFOLIO_DAILY_LOSS_LIMIT:'共同資金今日虧損達上限',PORTFOLIO_GROSS_EXPOSURE_LIMIT:'共同名義曝險額度已滿',
 PORTFOLIO_OPEN_RISK_LIMIT:'共同持倉風險額度已滿',PORTFOLIO_CAPITAL_LIMIT:'共同資金額度已滿',
 PORTFOLIO_OPPOSITE_POSITION:'另一市場已有反向部位',PORTFOLIO_DUPLICATE_POSITION:'另一市場已有同幣種部位',
 PORTFOLIO_DRAWDOWN_LIMIT:'共同回撤達保護上限，等待檢視',PORTFOLIO_BUSY:'共同下單檢查使用中，下一輪再評估',
 PORTFOLIO_UNRESOLVED_SUBMISSION:'共同資金有送單結果待核對',UNRESOLVED_SUBMISSION:'送單結果待核對',
 ENGINE_UNAVAILABLE:'交易引擎無法連線',CONTINUOUS_WATCH_NOT_RUNNING:'應持續運行的排程未啟動',
 WATCH_HEARTBEAT_STALE:'排程心跳過期',CYCLE_STALE:'研究週期未按時更新',
 STALE_OR_UNVERIFIED_LOCK:'程序鎖狀態待核對',SCHEMA_INVALID:'資料格式驗證失敗',
 ENTRY_ALLOWANCE_STATE_INVALID:'每日額度資料待核對',ENGINE_RECONNECTING:'引擎重新連線中',ENGINE_CONFIRMED_ABSENT:'正在恢復引擎',
 WATCH_CONFIRMED_ABSENT:'正在恢復排程',ENGINE_UNAVAILABLE_PROCESS_PRESENT:'引擎無回應，程序仍存在',
 WATCH_PROCESS_PRESENT_WITHOUT_LOCK:'排程程序與鎖狀態不一致',PROCESS_INVENTORY_UNAVAILABLE:'程序狀態待核對',
 RESTART_BACKOFF_LIMIT:'已達重新啟動保護限制',DEMO_PROTECTION_NOT_OBSERVED:'尚未取得停損核對資料',
 DEMO_PROTECTION_STATE_STALE:'停損資料已過期',DEMO_PROTECTION_STATE_INVALID:'停損資料格式待核對',
 DEMO_PROTECTION_ORDER_EVIDENCE_INVALID:'停損訂單證據待核對'};
const reasonLabel=value=>typeof value==='string'?(reasonLabels[value]??value):'原因待核對';
const actionLabel=value=>({'buy':'現貨做多','open-long':'合約做多','open-short':'合約做空','hold':'等待訊號'}[value]??'狀態待確認');
const entryStateLabels={paused:'進場已暫停',engine_unavailable:'引擎異常',fault:'異常待處理',waiting_risk:'風控等待',
 starting:'啟動中',waiting_signal:'等待訊號',running:'持續運行',manual:'手動週期'};
function renderOperations(){
 const {data,mode,preview,error}=store.state,raw=data?.operations;
 const ops=!preview&&raw?.mode===mode?raw:null;
 const states=entryStateLabels;
 text('operations-status',preview?'展示模式':ops?(states[ops.entryState]??'狀態待核對'):'等待運行資料');
 $('operations-status').dataset.tone=ops?.healthy===false?'warning':'normal';
 text('operations-engine',ops?.engineAvailable===true?'已連線':ops?.engineAvailable===false?'無法連線':'—');
 text('operations-watch',ops?.stopped===true?'已暫停':ops?.watchRunning===true?'持續運行':ops?.watchRunning===false?'未運行':'—');
 text('operations-cycle',ops?((ops.freshCycle?'正常更新 · ':'未確認新週期 · ')+taipeiTime(ops.freshness?.lastCycleCompletedAt)):'—');
 text('operations-entry',ops?(states[ops.entryState]??'待核對'):'—');
 const liveDemo=!preview&&['demo','demo-futures'].includes(mode),supervisor=liveDemo?data?.supervisor:null;
 const supervisorMode=Array.isArray(supervisor?.states)?supervisor.states.find(value=>value.mode===mode):null;
 const supervisorFresh=supervisor?.available===true&&supervisor?.fresh===true&&supervisor?.running===true;
 text('operations-supervisor',preview?'展示模式':!liveDemo?'Demo 專用':!supervisorFresh?
  (supervisor?.fresh===false?'守護狀態待確認':'尚未確認守護程序'):!supervisorMode?'守護程序運行中 · 此環境待確認':
  supervisorMode.action==='alert'?'守護中 · '+reasonLabel(supervisorMode.reason):
  supervisorMode.action==='start_engine'?'正在恢復引擎':supervisorMode.action==='start_watch'?'正在恢復排程':
  supervisorMode.stopped===true||supervisorMode.reason==='ENTRY_STOPPED'?'守護中 · 持續維持持倉退出':
  supervisorMode.reason==='CONTINUOUS_NOT_REQUESTED'?'守護程序運行中 · 此環境未要求持續運行':
  supervisorMode.reason==='RUNNING'?'守護中 · 引擎與排程正常':'守護中 · '+reasonLabel(supervisorMode.reason));
 $('operations-supervisor').dataset.tone=liveDemo&&(!supervisorFresh||supervisorMode?.action==='alert')?'warning':'normal';
 text('operations-supervisor-time','守護檢查時間 '+taipeiTime(supervisor?.observedAt));
 const protection=liveDemo&&Array.isArray(data?.protection)?data.protection.find(value=>value.mode===mode):null;
 const protectionFresh=protection?.available===true&&protection?.fresh===true&&protection.status!=='unknown'&&Array.isArray(protection.activeStops);
 const activeStops=protectionFresh?protection.activeStops:[],unresolved=protectionFresh&&Number.isSafeInteger(protection.unresolvedStops)?protection.unresolvedStops:null;
 const positions=liveDemo&&Array.isArray(data?.account?.positions)?data.account.positions:null;
 const configuredPairs=Array.isArray(data?.policy?.pairs)?data.policy.pairs:[];
 const capabilityReady=protectionFresh&&protection.configured===true&&configuredPairs.length>0&&
  configuredPairs.every(pair=>protection.capabilities?.[pair]?.status==='capability_validated');
 let protectionText=preview?'展示模式':!liveDemo?'Demo 專用':!protectionFresh?
  '尚未確認 · '+reasonLabel(protection?.error):unresolved>0?
  unresolved+' 筆待對帳 · '+activeStops.length+' 張有效停損單':activeStops.length?
  '已核對 '+activeStops.length+' 張有效停損單':positions?.length?
  positions.length+' 筆持倉 · 尚未觀測到有效停損單':positions?.length===0&&capabilityReady?
  '能力已就緒 · 無持倉，尚無有效停損單':capabilityReady?'能力已就緒 · 持倉狀態待確認':'能力待確認 · 尚無有效停損單';
 text('operations-protection',protectionText);
 $('operations-protection').dataset.tone=liveDemo&&(!protectionFresh||unresolved>0||!activeStops.length&&positions?.length>0||!capabilityReady)?'warning':'normal';
 text('operations-protection-time','停損核對時間 '+taipeiTime(protection?.asOf));
 const stopOrders=$('operations-protection-orders');stopOrders.replaceChildren();
 for(const stop of activeStops){
  stopOrders.append(element('li','',stop.pair+' · 訂單 '+stop.orderId+' · '+(stop.side==='buy'?'買入退出':'賣出退出')+
   ' · 數量 '+number(stop.amount,8)+' · 觸發價 '+number(stop.stopPrice,4)+' · 台灣 '+taipeiTime(stop.observedAt)));
 }
 if(!stopOrders.childElementCount)stopOrders.append(element('li','muted',protectionFresh?'目前沒有可列出的有效停損訂單。':'等待新鮮且一致的訂單證據。'));
 let notice=preview?'展示模式不提供實際排程與風控狀態。':error?'工作區讀取失敗，無法確認程式是否運行。':
  !ops?'等待讀取引擎、排程與風控狀態。':ops.stopped?'新進場已暫停；現有持倉退出仍由交易引擎管理。':
  ops.healthy===false?'有運行或資料異常需要處理；請查看下列原因。':ops.entryWait?
  reasonLabel(ops.entryWait.reason)+(ops.entryWait.reviewRequired?'。風險保護維持生效，需先檢視。':'。程式會在下一輪重新檢查，不取消風控限制。'):
  ops.entryState==='starting'?'排程正在啟動，等待第一輪訂單流與已收盤 K 線檢查。':
  ops.entryState==='waiting_signal'?'排程正常，最新訊號尚未形成可執行交易。':
  ops.watchRunning?(liveDemo?'每 1 分鐘檢查新訂單流與報價；5m 已收盤 K 線只供風險與觀察。訊號與風控通過後送出 Demo 訂單。':'排程持續檢查資料；訊號與風控通過後執行模擬決策。'):'目前沒有持續排程，請以運行狀態為準。';
 text('operations-notice',notice);
 const allowance=ops?.dailyEntryAllowance;
 text('operations-allowance',allowance?.unlimited===true?'未設定次數上限':Number.isSafeInteger(allowance?.remaining)?number(allowance.remaining,0)+' / '+number(allowance.limit,0)+' 次':'—');
 text('operations-reset',allowance?.unlimited===true?'符合策略與資金條件即可持續進場':allowance?.resetAt?'台灣 '+taipeiTime(allowance.resetAt)+' 重置（每日 08:00）':'重置時間 —');
 const problems=$('operations-problems');problems.replaceChildren();
 for(const reason of Array.isArray(ops?.problems)?ops.problems:[])problems.append(element('li','',reasonLabel(reason)));
 problems.hidden=!problems.childElementCount;
}
function renderDiagnostics(){
 const {data,mode,preview,error}=store.state,raw=data?.diagnostics;
 const report=!preview&&raw?.schemaVersion===1&&raw?.source==='local-demo-entry-diagnostics'&&raw.mode===mode&&
  raw.ruleVersion===data?.strategy?.ruleVersion?raw:null;
 const count=value=>Number.isSafeInteger(value)&&value>=0?number(value,0):'—';
 text('diagnostics-window',report?(data.session?'本輪自 '+taipeiTime(report.window?.from):'最近 24 小時')+' · '+report.ruleVersion:'等待目前版本的觀測期間');
 text('diagnostics-summary',preview?'展示模式不混入實際進場統計。':error?'工作區讀取失敗，進場狀態待確認。':!report?'等待本版策略週期。':
  '共 '+count(report.cycles?.total)+' 輪 · 完成 '+count(report.cycles?.completed)+' · 風控等待 '+count(report.cycles?.waiting)+
  ' · 異常 '+count(report.cycles?.failed)+' · 未完成 '+count(report.cycles?.incomplete)+
  '；'+count(report.candidates?.eligible)+' / '+count(report.candidates?.total)+' 個幣種候選通過訊號與下單金額檢查。'+
  (report.funnel?' 按評估輪次：訊號與成本通過 '+count(report.funnel.signalAndCostPassed)+
   ' → 金額通過 '+count(report.funnel.sizePassed)+' → 提議進場 '+count(report.funnel.entryProposed)+
   ' → 已提交 '+count(report.funnel.submitted)+'。合格但未選用 '+count(report.funnel.eligibleWithoutProposal)+
   ' 輪（需再查持倉、重複幣種與曝險）；提交數不等於成交數。':''));
 for(const [id,values,empty] of [['diagnostics-signal',report?.signalReasons,'尚無訊號排除紀錄'],
  ['diagnostics-global',report?.globalWaitReasons,'尚無帳戶風控等待'],['diagnostics-fault',report?.faultReasons,'尚無已記錄異常']]){
  const list=$(id);list.replaceChildren();
  for(const item of (Array.isArray(values)?values:[]).slice(0,5)){
   const row=element('li');row.append(element('span','',reasonLabel(item.reason)),element('strong','',count(item.count)+' 次'));list.append(row);
  }
  if(!list.childElementCount)list.append(element('li','muted',report?empty:'—'));
 }
 text('diagnostics-latest','最新逐幣檢查 · '+taipeiTime(report?.latest?.createdAt));
 const pairs=$('diagnostics-pairs');pairs.replaceChildren();
 for(const pair of Array.isArray(report?.latest?.pairs)?report.latest.pairs:[]){
  const row=element('article','diagnostic-pair'),heading=element('h3');
  heading.append(element('span','',pair.pair),element('span',pair.eligible?'positive':'muted',pair.eligible?'訊號通過':pair.sizingReason?'下單金額受限':'訊號未達標'));
  row.append(heading);
  const checks=Array.isArray(pair.directionChecks)?pair.directionChecks:[];
  for(const check of checks){
   const metrics=check.metrics,content=element('div','diagnostic-direction');
   content.append(element('strong','',actionLabel(check.action)+' · '+(check.eligible?'通過':'等待')),
    element('p','','1h '+signed(metrics?.return1hPct)+'% · 4h 參考 '+signed(metrics?.return4hPct)+'% · 量能 '+number(metrics?.volumeVsPrior19,2)+' 倍'),
    element('p','','收盤 '+number(metrics?.lastClose,4)+' · SMA8 '+number(metrics?.sma8,4)+' · SMA20 '+number(metrics?.sma20,4)),
    element('p','','突破觸發價 '+number(check.breakout?.trigger,4)+' · 目標空間 '+number(check.costSpace?.targetBps,1)+' bps · 含成本門檻 '+number(check.costSpace?.requiredBps,1)+' bps'),
    element('p','muted',(check.reasons?.length?check.reasons.map(reasonLabel).join('、'):'無已記錄排除原因')));
   row.append(content);
  }
  if(!checks.length)row.append(element('p','muted','方向指標尚未取得。'));
  row.append(element('p','diagnostic-cost','往返成本估計 '+number(pair.cost?.estimatedRoundTripCostBps,1)+' bps · '+
   (pair.sizingReason?reasonLabel(pair.sizingReason):'候選下單金額 '+number(pair.stakeUsdt,4)+' USDT')));
  pairs.append(row);
 }
 if(!pairs.childElementCount)pairs.append(element('p','muted','尚無本版逐幣檢查資料。'));
 text('diagnostics-note','每個原因在同一幣種、同一輪只計一次；技術驗證單不列入訊號統計。'+
  (report?.warnings?.length?' 有 '+report.warnings.length+' 項紀錄缺失，統計可能不完整。':'')+
  (report?.exclusions?.limited?' 僅顯示最新 288 輪。':''));
}
function renderPortfolio(){
 const {data,mode,preview,error}=store.state,raw=data?.portfolio;
 const report=!preview&&['demo','demo-futures'].includes(mode)&&raw?.schemaVersion===1&&
  raw?.source==='freqtrade-demo-portfolio'?raw:null;
 const count=value=>Number.isSafeInteger(value)&&value>=0?number(value,0):'—';
 text('portfolio-status',preview?'展示模式':!report?'等待共同報告':report.drawdownLimitBreached===true?'回撤保護已觸發':
  report.evidenceComplete===true?'共同資金追蹤中':'資料待核對');
 $('portfolio-status').dataset.tone=report&&(report.evidenceComplete!==true||report.drawdownLimitBreached===true)?'warning':'normal';
 text('portfolio-capital',number(report?.capitalUsdt));text('portfolio-exposure',number(report?.grossExposureUsdt));
 const net=report?.evidenceComplete===true?report.netPnlUsdt:null;
 text('portfolio-net',net===null||net===undefined?'—':(Number(net)>0?'+':'')+number(net,4));
 $('portfolio-net').className=net===null||net===undefined?'':Number(net)>0?'positive':Number(net)<0?'negative':'';
 text('portfolio-drawdown',number(report?.sampledMaxDrawdownUsdt,4));
 text('portfolio-notice',preview?'展示模式不提供實際共同資金績效。':error?'工作區讀取失敗，共同資金狀態待確認。':
  !report?'以扣除費用後淨利、較小回撤為目標，等待現貨與合約 Demo 的共同報告。':
  '以扣除費用後淨利、較小回撤為目標。策略已平倉 '+count(report.strategy?.closedTrades)+' 筆，技術驗證已平倉 '+count(report.probes?.closedTrades)+
  ' 筆，分開統計。'+(report.evidenceComplete===true?'淨損益包含本輪已實現與當前浮動損益。':'資料核對完成前，合計淨損益顯示 —。')+
  (report.drawdownLimitBreached===true?' 回撤保護維持生效，等待檢視。':''));
 const warnings=$('portfolio-problems');warnings.replaceChildren();
 for(const warning of (Array.isArray(report?.warnings)?report.warnings:[]).slice(0,8))warnings.append(element('li','',reasonLabel(warning.code)));
 warnings.hidden=!warnings.childElementCount;
 text('portfolio-asof',report?'台灣 '+taipeiTime(report.asOf)+' · '+count(report.sampleCount)+' 筆淨資產觀測 · 回撤為已觀測樣本的結果'+
  (report.grossExposureUsdt===undefined||report.grossExposureUsdt===null?' · 持倉曝險快照待更新':''):'等待現貨與合約共同資金快照');
}
let selected=31,marketIdentity=null;
function renderTiming(){
 const v=timingView({...store.state,elapsedMs:performance.now()-(store.state.dataReceivedMono??performance.now())});
 text('timing-status',v.status);$('timing-status').dataset.tone=v.tone;
 for(const key of ['clock','lastClose','delay','nextCandle','nextResearch','expiry'])text('timing-'+key,v[key]);
}
function renderForward(){
 const {data,mode,preview,error}=store.state,raw=data?.forward;
 const matchingMode=raw?.mode===mode,matchingVersion=typeof raw?.version==='string'&&
  (!data?.strategy?.ruleVersion||raw.version===data.strategy.ruleVersion);
 const available=!preview&&['demo','demo-futures'].includes(mode)&&raw?.schemaVersion===1&&
  raw?.source==='freqtrade-demo-forward-trial'&&matchingMode&&matchingVersion;
 const report=available?raw:null;
 const count=value=>Number.isSafeInteger(value)&&value>=0?number(value,0):'—';
 const amount=value=>['number','string'].includes(typeof value)&&value!==''&&Number.isFinite(Number(value))?
  (Number(value)>0?'+':'')+number(value,4):'—';
 const localTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?
  new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
 const statuses={parameter_comparison:'倍數分組試驗 · 請分組比較',incomplete_evidence:'資料不完整 · 待核對',awaiting_closed_trades:'等待策略平倉',collecting_sample:'持續累積實際成交',preliminary_sample_available:'已有初步樣本 · 尚未完成驗證'};
 text('forward-status',report?(statuses[report.validation?.status]??'驗證狀態待確認'):preview?'展示模式':mode==='dry-run'?'僅顯示 Demo 實際成交':'等待本輪報告');
 $('forward-status').dataset.tone=report?.validation?.evidenceComplete===true?'normal':'warning';
 text('forward-version','策略版本 '+(report?.version??'—'));
 text('forward-started','啟用時間 '+localTime(report?.startedAt));text('forward-asof','成交報告時間 '+localTime(report?.asOf));
 const validPnl=group=>group?.pnlComplete===true;
 for(const [id,value] of [['forward-open',report?.strategy?.openTrades],['forward-closed',report?.strategy?.closedTrades],
  ['forward-probe-open',report?.probes?.openTrades],['forward-probe-closed',report?.probes?.closedTrades]])text(id,count(value));
 for(const [id,group,key] of [['forward-net',report?.strategy,'netRealizedUsdt'],['forward-average',report?.strategy,'averageNetUsdt'],['forward-probe-net',report?.probes,'netRealizedUsdt']]){
  const value=validPnl(group)?group[key]:null,display=amount(value);text(id,display);
  $(id).className=display==='—'?'':Number(value)<0?'negative':Number(value)>0?'positive':'';
 }
 const minimum=Number.isSafeInteger(report?.validation?.minValidClosedTrades)&&report.validation.minValidClosedTrades>=30?report.validation.minValidClosedTrades:30,
  valid=report?.validation?.validStrategyClosedTrades,hasProgress=Number.isSafeInteger(valid)&&valid>=0;
 text('forward-progress-count',(hasProgress?count(valid):'—')+' / '+minimum+' 筆');
 const progress=$('forward-progress-bar');progress.hidden=!hasProgress;progress.max=minimum;progress.value=hasProgress?Math.min(valid,minimum):0;
 progress.setAttribute('aria-valuetext',hasProgress?valid+' 筆有效策略平倉，初步樣本門檻 '+minimum+' 筆':'尚無本輪樣本資料');
 text('forward-progress-note',report?.validation?.evidenceComplete===false?
  '有效平倉數僅供追蹤；資料核對完成前，不認定已取得完整初步樣本。':
  '累積 '+minimum+' 筆有效策略平倉後，評估扣除費用後的淨利與回撤是否達標。');
 let notice=preview?'展示模式不提供實際 Demo 成交結果。':mode==='dry-run'?'切換至現貨或合約 Demo，查看本輪實際成交。':
  !raw?'尚未取得本輪成交報告，無法確認策略或驗證單的筆數與損益。':!available?'報告的環境或策略版本與目前選擇不一致，等待重新產生本輪報告。':
  report.validation?.evidenceComplete===false?'資料尚未核對完整；缺失的損益顯示 —，請查看下方資料檢查。':
  '僅計入此版本啟用後、已確認歸因的 Demo 成交。未平倉損益不計入已實現淨利。';
 const unresolved=report?.journal?.unresolvedSubmissions;
 if(Array.isArray(unresolved)&&unresolved.length)notice+=' 有 '+unresolved.length+' 筆送單結果待核對。';
 const reportTime=Date.parse(report?.asOf),observedTime=Date.parse(data?.observedAt);
 if(report&&Number.isFinite(reportTime)&&Number.isFinite(observedTime)&&observedTime-reportTime>600000)
  notice+=' 成交報告已超過 10 分鐘未更新，請以報告時間為準。';
 if(error&&!preview)notice='工作區讀取失敗，無法確認本輪成交結果。';
 text('forward-notice',notice);
 const volume=report?.volumeComparison?.version==='volume-forward-v1'&&!error?report.volumeComparison:null;
 const volumeList=$('volume-comparison-arms');volumeList.replaceChildren();
 const phaseNames={disabled:'尚未啟用',scheduled:'已排定',running:'測試中',window_complete:'本輪時段結束 · 已回到 0.8 倍基準'};
 text('volume-comparison-status',volume?(phaseNames[volume.phase]??'待核對')+' · '+localTime(volume.startAt)+' 至 '+localTime(volume.endAt)+
  (volume.current?' · 本時段 '+volume.current.minimum+' 倍':'')+'。每 5 分鐘評估、每 6 小時換組；原持倉沿用進場計畫。':'等待試驗資料。');
 for(const arm of volume?.arms??[]){
  volumeList.append(element('li','',arm.minimum+' 倍：持倉 '+count(arm.openTrades)+'／已平 '+count(arm.closedTrades)+
   ' · 扣費淨利 '+amount(arm.pnlComplete?arm.netRealizedUsdt:null)+' USDT · 已平倉累積回撤 '+amount(arm.pnlComplete?arm.closedTradeDrawdownUsdt:null)+' USDT'+
   (arm.closedTrades===0?' · 尚無平倉樣本':'')));
 }
 if(volume){
  text('forward-progress-note','上方為 v8 策略家族合計；倍數組別須各自累積樣本，不合併判定優勝。回撤仍需搭配共同資金的浮動損益。');
 }
 const review=report?.profitReview?.status==='observed'&&report?.validation?.evidenceComplete===true&&!error?report.profitReview:null;
 const profitTrades=$('profit-review-trades'),profitExits=$('profit-review-exits');profitTrades.replaceChildren();profitExits.replaceChildren();
 text('profit-review-note',review?
  '僅使用開始記錄後、約每分鐘讀到的引擎淨損益；可能漏掉分鐘內高低點。費用已包含在淨利內，未平倉只列已記錄的進場費用。':
  preview?'展示模式不提供實際獲利保留資料。':'尚無完整獲利觀測；不推算未記錄的浮盈。');
 const exitNames={rules_target:'策略止盈',rules_stop:'策略停損',rules_time:'持倉到期',stoploss_on_exchange:'交易所停損',force_exit:'主動平倉',trailing_stop_loss:'移動停損',roi:'ROI 退出'};
 for(const [scope,label] of [['strategy','策略'],['probes','技術驗證']]){
  for(const row of (review?.[scope]?.trades??[]).slice(-6)){
   const open=row.isOpen===true,net=open?row.netUnrealizedUsdt:row.netRealizedUsdt;
   profitTrades.append(element('li','',label+' #'+row.tradeId+' · '+row.pair+' · '+(open?'未實現':'已實現')+' '+amount(net)+
    ' USDT · 引擎費用 '+amount(row.engineRecordedFeesUsdt)+' USDT'+(open?'（進場）':'')+
    ' · 已觀測淨損益高點 '+amount(row.sampledPeakNetUsdt)+' · 浮盈回吐 '+amount(row.sampledGivebackUsdt)+
    ' USDT · '+count(row.openPnlSamples)+' 次持倉觀測 · 開始 '+localTime(row.firstObservedAt)));
  }
  for(const row of review?.[scope]?.byExitReason??[])
   profitExits.append(element('li','',label+' · '+(exitNames[row.exitReason]??row.exitReason??'退出原因待確認')+' · '+
    count(row.closedTrades)+' 筆平倉 · 淨利 '+amount(row.netRealizedUsdt)+' USDT · 引擎費用 '+amount(row.engineRecordedFeesUsdt)+' USDT'));
 }
 const evidence=$('forward-evidence'),warnings=$('forward-warnings');evidence.replaceChildren();warnings.replaceChildren();
 const warningLabels={DEMO_SOURCE_NOT_ATTESTED:'Demo 資料來源待確認',HISTORY_NOT_CONFIRMED_COMPLETE:'完整交易歷史待確認',
  INVALID_NET_PNL:'已實現損益缺失或格式不正確',UNRESOLVED_SUBMISSION:'送單結果尚未確認',
  UNATTRIBUTED_TRIAL_TRADE:'有交易尚未歸因至本輪或驗證單',TRADE_VERSION_MISMATCH:'交易版本不一致',
  ENTRY_SUBMISSION_NOT_CONFIRMED:'成交與送單紀錄尚未完整對上',AMBIGUOUS_ENTRY_JOURNAL:'成交對應到多筆送單紀錄',
  SUBMITTED_TRADE_MISSING_OR_AMBIGUOUS:'已送出的交易尚未在完整歷史中確認',DUPLICATE_HISTORY_TRADE_ID:'交易歷史有重複編號',
  DUPLICATE_TRADE_ID:'交易編號重複',CLOSED_TRADE_HAS_OPEN_ORDER:'已平倉交易仍有未結訂單',INVALID_CLOSE_TIMESTAMP:'平倉時間待核對',
  INVALID_OPEN_TIMESTAMP:'開倉時間待核對',TRADE_MODE_MISMATCH:'交易環境不一致'};
 for(const [label,group] of [['策略',report?.strategy],['技術驗證',report?.probes]]){
  for(const trade of (Array.isArray(group?.trades)?group.trades:[]).slice(-6)){
   const ids=Array.isArray(trade.orderIds)?trade.orderIds.filter(id=>['number','string'].includes(typeof id)).map(String):[];
   evidence.append(element('li','',label+' · 交易 #'+String(trade.tradeId??'—')+' · '+String(trade.pair??'—')+' · '+
    (trade.isOpen===true?'未平倉':trade.isOpen===false?'已平倉':'狀態待確認')+(ids.length?' · 訂單 '+ids.join('、'):' · 訂單編號尚未取得')));
  }
 }
 if(!evidence.childElementCount)evidence.append(element('li','',report?'本輪報告尚無可列出的成交。':'尚無本輪成交報告。'));
 for(const warning of (Array.isArray(report?.warnings)?report.warnings:[]).slice(0,12))
  warnings.append(element('li','',warningLabels[warning.code]??'有資料完整性問題待核對'+(typeof warning.code==='string'?'（'+warning.code+'）':'')));
 const warningCount=Array.isArray(report?.warnings)?report.warnings.length:0;
 if(warningCount>12)warnings.append(element('li','','另有 '+(warningCount-12)+' 項資料問題，請核對完整報告。'));
 warnings.hidden=!warningCount;
}
setInterval(renderTiming,1000);
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
 const tickIndices=Array.from({length:width<500?3:6},(_,i)=>Math.round(i*(candles.length-1)/((width<500?3:6)-1)));
 for(const i of tickIndices.filter(i=>i<candles.length))make('text',{x:x(i),y:height-5,'text-anchor':i===0?'start':i===candles.length-1?'end':'middle'},clock(candles[i].openTime));
 target.append(svg);target.setAttribute('aria-label',`${market.pair} ${market.timeframe??'15m'} 行情，${candles.length} 根已收盤 K 線。線為收盤軌跡，直線為高低價，底部為成交量。選取 ${dateTime(chosen.openTime)}，開盤 ${number(chosen.open)}、最高 ${number(chosen.high)}、最低 ${number(chosen.low)}、收盤 ${number(chosen.close)}。`);
}
function render(){
 renderTiming();
 renderForward();
 renderOperations();
 renderDiagnostics();
 renderPortfolio();
 const {data,market,preview,mode,loading,error,marketError}=store.state;
 text('session-scope',preview?'展示資料 · 非本輪成交':data?.session?'本驗證輪開始 '+new Date(data.session.startedAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})+'（台灣時間）· 僅統計此後開倉的 Demo 成交；交易所餘額未重置':data?mode==='dry-run'?'此處為 Dry-run；Demo 驗證轮起點另見下方損益範圍':'未設定驗證輪起點 · 依現有資料範圍顯示':'等待驗證輪資料');
 text('pnl-label',data?.session?'本驗證輪已實現':'引擎歷史已實現');
 text('pnl-scope',data?.session?'本輪各版本／驗證單 · 已含費用':'含舊版策略／驗證單 · 已含費用');
 const futures=mode==='demo-futures',pairs=data?.policy?.pairs??['BTC','ETH','SOL','BNB'].map(p=>p+'/USDT'+(futures?':USDT':''));
 if([...$('pair').options].map(o=>o.value).join()!==pairs.join()){$('pair').replaceChildren(...pairs.map(p=>{const o=element('option','',p);o.value=p;return o;}));}
 $('pair').value=store.state.pair;
 text('market-timeframe',market?.timeframe??data?.strategy?.timeframe??'—');
 text('landscape-count','探索最近 '+(market?.candles?.length??'—')+' 根 K 線');
 text('research-market-label',futures?'Binance Demo 永續 · 公開資料':'Binance Spot · 公開資料');
 text('exposure-label',futures?'保證金使用':'曝險使用');text('exposure-limit-label',futures?'總保證金上限':'總曝險上限');text('stake-label',futures?'單筆保證金上限':'單筆投入上限');
 $('futures-limits').hidden=!futures;text('notional-limit','最高 '+(data?.policy?.maxLeverage??3)+'× · 單筆 '+(data?.policy?.maxNotionalUsdt??150)+' / 合計 '+(data?.policy?.maxTotalNotionalUsdt??150)+' USDT');
 document.body.classList.toggle('is-preview',preview);$('refresh').disabled=loading;text('refresh',loading?'…':'↻');$('preview').setAttribute('aria-pressed',String(preview));text('preview',preview?'離開展示 ↗':'開啟展示 ↗');
 text('source-label',preview?'EXHIBITION / SAMPLE DATA':futures?'DEMO FUTURES / ISOLATED / MAX '+(data?.policy?.maxLeverage??'—')+'×':mode==='demo'?'BINANCE DEMO / VIRTUAL':'DRY-RUN / LOCAL');
 const strategyNote=data?.strategy?.decisionEngine==='rules'?(data.strategy.rulesReady?'新版突破策略已載入':'新版突破策略等待引擎載入')+' · '+
  (entryStateLabels[data.operations?.entryState]??(data.stopped?'進場已暫停':'排程狀態待確認'))+' · 每 30 秒更新':'唯讀監看 · 每 30 秒更新';
 text('notice',preview?'展示中的行情、績效與提案皆為範例。':error??(data?.engineError?'帳戶尚未連線或驗證未通過；公開行情可獨立查看。':data?strategyNote:'正在讀取工作區…'));
 document.querySelector('.account-band .summary-item > span').firstChild.nodeValue=(preview?'示例資產':'策略資產')+' ';text('balance',number(data?.account?.total));text('balance-note',preview?'示例帳戶 · 非實際資金':data?.account?'Demo 帳戶總值 '+number(data.account.accountTotal)+' USDT':'等待引擎連線');
 const pnl=data?.summary?.netRealizedUsdt;text('pnl',signed(pnl));$('pnl').className=pnl===null||pnl===undefined?'':Number(pnl)>=0?'positive':'negative';
 const positions=data?.account?.positions??[],max=data?.policy?.maxExposureUsdt??'50',used=data?.account?positions.reduce((sum,p)=>sum+Number(p.stake??0),0):null,ratio=used===null?0:Math.max(0,Math.min(100,used/Number(max)*100));
 text('position-count',(data?.account?positions.length:'—')+' / '+(data?.policy?.maxOpenTrades??2));text('exposure',max+' USDT');text('exposure-used',number(used));text('exposure-max',max);$('risk-fill').style.width=ratio+'%';$('risk-meter').setAttribute('aria-valuenow',String(ratio));$('risk-meter').setAttribute('aria-valuetext',used===null?'尚未取得持倉':number(used)+' / '+max+' USDT');
 const stages={idle:'待命',completed:'已完成',failed:'執行失敗',research:'研究中',analyze:'分析中',execute:'執行中',collecting:'研究中',analyzing:'分析中',executing:'執行中',waiting_risk:'風控等待',waiting_candle:'等待下一根 K 線',waiting_decision:'等待下一分鐘判斷',aborted:'週期已中止'};
 text('cycle-state',data?.operations?.healthy===false?'異常待處理':stages[data?.cycle?.stage]??'待命');text('cycle-note',preview?'示例流程 · 不代表模型正在運作':'最後記錄狀態 · 非即時活動');
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
 text('flow-market','Demo 成交與前五檔深度');text('flow-proposal','鏈上背景與模型，獨立記錄');text('flow-engine','Freqtrade 下單與持倉保護');
 const list=$('activity-list');list.replaceChildren();
 for(const d of (data?.decisions??[]).slice(0,5)){const row=element('div','activity-item');row.append(element('time','',clock(d.at)),element('strong','',String(d.action).toUpperCase()),element('span','',d.pair+' · '+d.reason));row.title=d.reason;list.append(row);}
 if(!data?.decisions?.length)list.append(element('p','empty','還沒有研究紀錄，完成一次研究週期後會顯示在這裡。'));
}
function renderTrades(){
 const {data,preview}=store.state,body=$('trades-body');body.replaceChildren();
 for(const t of data?.trades??[]){const row=element('tr');row.append(element('td','',positionLabel(t)),element('td','',dateTime(t.closedAt)),element('td',Number(t.profit)>=0?'positive':'negative',signed(t.profit)),element('td','',t.exitReason??'—'));body.append(row);}
 if(!data?.trades?.length){const row=element('tr'),cell=element('td','empty',data?.trades?'目前沒有已平倉交易。':data?.historyError?'交易紀錄讀取失敗，帳戶狀態仍可查看。':'引擎尚未連線，無法讀取交易紀錄。');cell.colSpan=4;row.append(cell);body.append(row);}
 text('history-note',preview?'固定示例 · 非實際成交':data?.trades?(data.session?'本驗證輪開倉的最近 50 筆已平倉交易。':'本次從 Freqtrade 讀取的最近 50 筆已平倉交易。'):data?.historyError==='OUTSIDE_SESSION_OPEN_POSITION'?'仍有輪前持倉，請先核對；本輪績效暫不顯示。':'等待取得引擎紀錄。');
}
function svgSurface(id,width,height){
 const target=$(id);target.replaceChildren();const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
 const add=(tag,attrs,label,parent=svg)=>{const e=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))e.setAttribute(key,String(value));if(label!==undefined)e.textContent=label;parent.append(e);return e;};target.append(svg);return {target,svg,add};
}
function drawAnalytics(){
 const candles=store.state.market?.candles;
 const flow=svgSurface('flow-chart',320,360),fa=flow.add;
 const flowDefs=fa('defs',{}),marker=fa('marker',{id:'demo-flow-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'},undefined,flowDefs);
 fa('path',{d:'M 0 0 L 10 5 L 0 10 Z',fill:'#527d72'},undefined,marker);
 const box=(x,y,w,label,fill='#f0f7f4')=>{fa('rect',{x,y,width:w,height:34,rx:7,fill,stroke:'#cfded8'});fa('text',{x:x+w/2,y:y+21,'text-anchor':'middle','font-size':12,fill:'#284d43'},label);};
 const arrow=(d,dashed=false)=>fa('path',{d,fill:'none',stroke:'#527d72','stroke-width':1.5,...(dashed?{'stroke-dasharray':'4 4'}:{}),'marker-end':'url(#demo-flow-arrow)'});
 ['訂單流採樣','方向判斷','成本與風控','Demo 下單','持倉保護與退出','實際扣費損益'].forEach((label,i)=>{box(12,15+i*51,145,label);if(i<5)arrow('M 84 '+(49+i*51)+' L 84 '+(66+i*51));});
 box(181,66,127,'鏈上資金背景','#f5f3fa');box(181,168,127,'模型獨立觀察','#f5f3fa');box(181,270,127,'記錄與成效比較','#f5f3fa');
 arrow('M 244 100 L 244 140 L 314 140 L 314 255 L 280 255 L 280 261',true);arrow('M 244 202 L 244 261',true);arrow('M 157 287 L 179 287',true);
 fa('text',{x:243,y:241,'text-anchor':'middle','font-size':10,fill:'#766482'},'不批准／阻擋進場');
 fa('text',{x:160,y:332,'text-anchor':'middle','font-size':10,fill:'#687b74'},'未通過檢查 → 記錄原因 → 下一輪繼續');
 flow.target.setAttribute('aria-label','現行 Demo 流程：訂單流採樣、方向判斷、成本與風控、Demo 下單、持倉保護與退出、實際扣費損益。鏈上資金與模型獨立觀察，只進入記錄與成效比較，不批准或阻擋進場。');
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
