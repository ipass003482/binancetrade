// Local immutable evidence only. No network, credentials or account clients.
import {readdir,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT} from '../src/paths.mjs';
import {createSpotCandidateReviewAccumulator} from '../src/spot-candidate.mjs';
export async function readSpotCandidateReview({date,directory=join(ROOT,'local/demo/spot-candidate-research')}={}){
 const start=Date.parse(date+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==date)throw Error('CANDIDATE_REVIEW_DATE');
 const inputs=[],review=createSpotCandidateReviewAccumulator({createdFrom:start,createdBefore:start+86400000});let names=[];
 try{names=(await readdir(directory)).filter(n=>/^candidates-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();}catch(e){if(e.code!=='ENOENT')throw e;}
 const missingTarget=!names.includes('candidates-'+date+'.jsonl');
 for(const name of names){
  const path=join(directory,name),file=await open(path,'r');let size;
  try{size=(await file.stat()).size;if(size){const tail=Buffer.alloc(1);await file.read(tail,0,1,size-1);if(tail[0]!==10)throw Error('TORN_CANDIDATE_JOURNAL');}}finally{await file.close();}
  inputs.push({path,status:'ok',bytes:size});if(!size)continue;
  // Snapshot the readable byte boundary so an active append cannot introduce a
  // half line. Outcomes written days after the candidate are still discovered.
  const stream=createReadStream(path,{encoding:'utf8',end:size-1}),lines=createInterface({input:stream,crlfDelay:Infinity});
  try{for await(const line of lines){if(line.length>1048576)throw Error('CANDIDATE_REVIEW_LINE_CAPACITY');if(line)review.consume(JSON.parse(line));}}finally{lines.close();stream.destroy();}
 }
 const report=review.finish();
 return {...report,date,timezone:'UTC',inputs,status:missingTarget?'unavailable':report.status};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--date'){console.error('Usage: node scripts/spot-candidate-review.mjs --date YYYY-MM-DD');process.exitCode=2;}
 else try{console.log(JSON.stringify(await readSpotCandidateReview({date:args[1]}),null,2));}catch{console.error('CANDIDATE_REVIEW_UNAVAILABLE');process.exitCode=1;}
}
