import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {journalAppend} from './io.mjs';
import {profitObservationBatch,newProfitObservations,buildProfitReview} from './profit-review.mjs';

// Called only under the existing forward.lock. The append-only samples survive
// report refreshes, watcher restarts and strategy-version rotation.
export async function refreshProfitReview(local,{report,trades}){
 if(report.validation?.evidenceComplete!==true)return buildProfitReview({report,trades});
 const file=join(local,'profit-observations.jsonl');let text='';
 try{text=await readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(text&&!text.endsWith('\n'))throw Error('PROFIT_OBSERVATIONS_INCOMPLETE');
 const previous=text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const fresh=newProfitObservations(previous,profitObservationBatch({report,trades}),report.mode);
 for(const row of fresh)await journalAppend(file,row);
 return buildProfitReview({report,trades,observations:[...previous,...fresh]});
}
