import {refreshForwardReport} from './forward-store.mjs';
import {refreshPortfolio} from './portfolio-store.mjs';
import {safeError} from './health.mjs';

// STOP governs entries, not the observation of existing trades and their exits.
// The supervisor fills this gap only while entries are paused. Normal watches
// retain ownership of their existing minute-based samplers.
export function createPausedEvidenceSampler({forward=refreshForwardReport,portfolio=refreshPortfolio,
 now=()=>Date.now(),intervalMs=60000}={}){
 if(!Number.isFinite(intervalMs)||intervalMs<60000)throw Error('PAUSED_EVIDENCE_INTERVAL_INVALID');
 const lastAttempts=new Map(),results=new Map();let lastPortfolioAttempt=null;
 return async({mode,local,client,continuous,stopped,engineAvailable})=>{
  if(!['demo','demo-futures'].includes(mode))throw Error('PAUSED_EVIDENCE_DEMO_REQUIRED');
  if(continuous!==true||stopped!==true||engineAvailable!==true)return null;
  const at=now();if(!Number.isFinite(at))throw Error('PAUSED_EVIDENCE_TIME_INVALID');
  const previous=lastAttempts.get(mode);
  if(previous!==undefined&&at>=previous&&at-previous<intervalMs)return results.get(mode)??null;
  lastAttempts.set(mode,at);
  const result={source:'supervisor-paused-evidence',attemptedAt:new Date(at).toISOString()};
  const observe=async fn=>{try{const report=await fn();return {status:'refreshed',asOf:report.asOf,
    evidenceComplete:report.validation?.evidenceComplete??report.evidenceComplete??false};}
   catch(error){return {status:'unavailable',error:safeError(error)};}};
  result.forward=await observe(()=>forward(local,client));
  // Both paused modes share one portfolio report; do not sample it twice in
  // the same supervisor tick. A failed read is throttled too, never busy-looped.
  if(lastPortfolioAttempt===null||at<lastPortfolioAttempt||at-lastPortfolioAttempt>=intervalMs){
   lastPortfolioAttempt=at;result.portfolio=await observe(()=>portfolio());
  }
  results.set(mode,result);return result;
 };
}
