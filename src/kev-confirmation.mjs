// Cross-cycle confirmation for the Kev order-flow route.  This is deliberately
// separate from the ten-second sampler: the sampler can observe continuously,
// while entry authority requires two adjacent decision windows.
export const KEV_CONFIRMATION_VERSION='kev-two-window-v1';
export const KEV_CONFIRMATION_WINDOWS=2;
export const KEV_CONFIRMATION_INTERVAL_MS=60000;

const actions=new Set(['buy','open-long','open-short']);
const keyOf=(pair,action)=>`${pair}|${action}`;
const emptyState=(mode,intervalMs=KEV_CONFIRMATION_INTERVAL_MS)=>({
 version:KEV_CONFIRMATION_VERSION,mode,intervalMs,signals:{},updatedAt:null
});

export function confirmationKey(pair,action){return keyOf(pair,action);}

export function normalizeConfirmationState(raw,{mode,intervalMs=KEV_CONFIRMATION_INTERVAL_MS}={}){
 const state=emptyState(mode,intervalMs);
 if(!raw||raw.version!==KEV_CONFIRMATION_VERSION||raw.mode!==mode||raw.intervalMs!==intervalMs||
  !raw.signals||typeof raw.signals!=='object'||Array.isArray(raw.signals))return state;
 for(const [key,row] of Object.entries(raw.signals)){
  if(typeof key!=='string'||!row||row.version!==KEV_CONFIRMATION_VERSION||row.mode!==mode||
   !actions.has(row.action)||typeof row.pair!=='string'||!Number.isSafeInteger(row.boundary)||row.boundary<=0||
   !Number.isSafeInteger(row.previousBoundary)||row.previousBoundary<0||!Number.isSafeInteger(row.count)||row.count<1||
   !Number.isSafeInteger(row.intervalMs)||row.intervalMs!==intervalMs||row.confirmed!== (row.count>=KEV_CONFIRMATION_WINDOWS))continue;
  state.signals[key]={...row};
 }
 state.updatedAt=typeof raw.updatedAt==='string'?raw.updatedAt:null;
 return state;
}

// A same-snapshot second pass (after Kev's review) must be idempotent.  A
// broken or skipped window resets the streak instead of carrying it forward.
export function advanceConfirmation(state,{mode,pair,action,snapshotId=null,boundary,intervalMs=KEV_CONFIRMATION_INTERVAL_MS,eligible,now=Date.now()}={}){
 const next=normalizeConfirmationState(state,{mode,intervalMs});
 const key=keyOf(pair,action),prior=next.signals[key];
 if(!actions.has(action)||typeof pair!=='string'||!Number.isSafeInteger(boundary)||boundary<=0){
  delete next.signals[key];next.updatedAt=new Date(now).toISOString();return {state:next,confirmation:null};
 }
 if(!eligible){
  delete next.signals[key];next.updatedAt=new Date(now).toISOString();return {state:next,confirmation:null};
 }
 if(prior?.boundary===boundary){
  next.updatedAt=new Date(now).toISOString();return {state:next,confirmation:prior};
 }
 const contiguous=prior&&prior.boundary+intervalMs===boundary;
 const count=contiguous?prior.count+1:1;
 const confirmation={version:KEV_CONFIRMATION_VERSION,mode,pair,action,snapshotId,
  boundary,previousBoundary:contiguous?prior.boundary:0,intervalMs,count,
  confirmed:count>=KEV_CONFIRMATION_WINDOWS,firstBoundary:contiguous?prior.firstBoundary:boundary,
  updatedAt:new Date(now).toISOString()};
 next.signals[key]=confirmation;next.updatedAt=confirmation.updatedAt;
 return {state:next,confirmation};
}

export function confirmationFor(state,pair,action){
 return normalizeConfirmationState(state,{mode:state?.mode,intervalMs:state?.intervalMs}).signals[keyOf(pair,action)]??null;
}

export function bindConfirmation(confirmation,{snapshotId,mode,pair,action,boundary,intervalMs=KEV_CONFIRMATION_INTERVAL_MS}={}){
 if(!confirmation||confirmation.version!==KEV_CONFIRMATION_VERSION||confirmation.mode!==mode||
  confirmation.pair!==pair||confirmation.action!==action||confirmation.snapshotId!==snapshotId||
  confirmation.boundary!==boundary||confirmation.previousBoundary!==boundary-intervalMs||
  confirmation.intervalMs!==intervalMs||confirmation.count<KEV_CONFIRMATION_WINDOWS||confirmation.confirmed!==true)
  return null;
 return {...confirmation};
}

export function confirmationForEntry(confirmation,{snapshot,mode,pair,action,now=Date.now()}={}){
 const boundary=snapshot?.decisionBoundary,intervalMs=snapshot?.decisionIntervalMs;
 if(!Number.isSafeInteger(boundary)||!Number.isSafeInteger(intervalMs)||
  !['demo','demo-futures'].includes(mode)||now<boundary||now>=boundary+intervalMs)return null;
 return bindConfirmation(confirmation,{snapshotId:snapshot.id,mode,pair,action,boundary,intervalMs});
}
