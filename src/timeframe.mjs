// Explicit duration metadata; historical snapshots without it remain 15m.
export function timeframeSpec(timeframe='15m'){
 if(!['5m','15m'].includes(timeframe))throw Error('TIMEFRAME_REJECTED');
 const minutes=timeframe==='5m'?5:15;
 return {timeframe,minutes,ms:minutes*60000,historyBars:480/minutes,hourBars:60/minutes,fourHourBars:240/minutes,maxHoldingBars:240/minutes,maxHoldingSeconds:14400};
}
export function tradingTimeframe(mode){
 if(!['dry-run','demo','demo-futures'].includes(mode))throw Error('MODE_REJECTED');
 return mode==='dry-run'?'15m':'5m';
}
