import { createHash } from 'node:crypto';
import { collectCosts } from './trading-costs.mjs';
import { FLOW_DECISION_INTERVAL_MS } from './entry-timing.mjs';

export const DECISION_COST_PREFETCH_LEAD_MS=10000;
const INTERVAL_MS=FLOW_DECISION_INTERVAL_MS;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;

function identity({policy,boundary,collectionAt}){
 if(!['demo','demo-futures'].includes(policy?.mode)||!Number.isSafeInteger(boundary)||boundary<=0||boundary%INTERVAL_MS!==0||
  !Number.isSafeInteger(collectionAt)||collectionAt<boundary||collectionAt>=boundary+INTERVAL_MS)
  throw Error('COST_PREFETCH_SLOT_INVALID');
 return {mode:policy.mode,boundary,collectionAt,deadline:boundary+INTERVAL_MS,
  key:createHash('sha256').update(JSON.stringify(canonical({policy,boundary,collectionAt}))).digest('hex')};
}

// Watcher-local, read-only fee work for one exact upcoming decision. There is
// no disk cache, timestamp refresh, cross-slot reuse, or quote/clock prefetch.
// Every promise settles to a value/error envelope, so abandoned reads cannot
// create unhandled rejections. A consumed failure is rethrown at the workflow's
// costs stage; STOP/abort drains the read without promoting it into a decision.
export function createDecisionCostPrefetch({readCosts=collectCosts,now=Date.now}={}){
 let current=null,closed=false,consuming=false;
 function start(slot,policy){
  const task={...slot,consumed:false,settled:false};
  task.promise=Promise.resolve().then(()=>readCosts(policy)).then(
   value=>({ok:true,value}),error=>({ok:false,error})).then(result=>{task.settled=true;return result;});
  current=task;return task;
 }
 function active(slot){
  const at=now();
  if(!Number.isFinite(at)||at<slot.collectionAt)throw Error('COST_PREFETCH_SLOT_NOT_READY');
  if(at>=slot.deadline)throw Error('COST_PREFETCH_SLOT_EXPIRED');
 }
 function prepare(input){
  if(closed||consuming)return false;
  const policy=structuredClone(input.policy),slot=identity({...input,policy}),at=now();
  if(!Number.isFinite(at)||at<slot.collectionAt-DECISION_COST_PREFETCH_LEAD_MS||at>=slot.collectionAt)return false;
  if(current&&(current.key===slot.key||!current.settled))return false;
  start(slot,policy);return true;
 }
 async function consume(input){
  if(closed)throw Error('COST_PREFETCH_CLOSED');
  if(consuming)throw Error('COST_PREFETCH_CONSUMPTION_IN_PROGRESS');
  const policy=structuredClone(input.policy),slot=identity({...input,policy});
  if(current?.key===slot.key&&current.consumed)throw Error('COST_PREFETCH_ALREADY_CONSUMED');
  active(slot);consuming=true;
  try{
   let task=current;
   if(task?.key!==slot.key){
    // A changed policy, mode or boundary must perform a fresh read. Drain an
    // old job first; never run two signed fee reads in this watcher helper.
    if(task)await task.promise;
    if(closed)throw Error('COST_PREFETCH_CLOSED');
    active(slot);task=start(slot,policy);
   }
   task.consumed=true;
   const result=await task.promise;
   if(closed)throw Error('COST_PREFETCH_CLOSED');
   if(!result.ok)throw result.error;
   active(slot);
   // Return the original facts unmodified. Host/native cost checks still own
   // source identity, per-pair rates and the unchanged age limit at execution.
   return result.value;
  }finally{consuming=false;}
 }
 async function drain(){
  closed=true;
  if(current)await current.promise;
 }
 return {prepare,consume,drain};
}
