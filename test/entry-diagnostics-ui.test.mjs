import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the actual renderer with a minimal DOM surface, without account,
// timer or browser bootstrapping side effects from the rest of the app.
const app=await readFile(new URL('../ui/app.mjs',import.meta.url),'utf8');
const renderer=app.slice(app.indexOf('function renderDiagnostics(){'),app.indexOf('function renderPortfolio(){'));
function render(data){
 const nodes=new Map();
 const element=(tag,cls,text)=>({textContent:text??'',children:[],append(...values){this.children.push(...values);},
  replaceChildren(){this.children=[];},get childElementCount(){return this.children.length;}});
 const $=id=>{if(!nodes.has(id))nodes.set(id,element('div'));return nodes.get(id);};
 runInNewContext(renderer+'\nrenderDiagnostics();',{store:{state:{mode:'demo',preview:false,error:null,data}},
  $,element,text:(id,value)=>{$(id).textContent=value;},number:String,taipeiTime:value=>value??'—',reasonLabel:String});
 return nodes;
}

test('warming diagnostic UI explicitly shows loading and unknown counts, never empty healthy statistics',()=>{
 const nodes=render({diagnostics:null,diagnosticsError:'DIAGNOSTICS_INDEX_WARMING'});
 assert.match(nodes.get('diagnostics-window').textContent,/建立.*診斷索引/);
 assert.match(nodes.get('diagnostics-summary').textContent,/載入中.*尚未確認/);
 assert.doesNotMatch(nodes.get('diagnostics-summary').textContent,/共 0|尚無.*異常/);
 for(const id of ['diagnostics-signal','diagnostics-global','diagnostics-fault'])assert.match(nodes.get(id).children[0].textContent,/載入中.*待確認/);
});

test('cached diagnostic UI shows the report observation time and failures remain unknown',()=>{
 const asOf='2026-09-29T12:00:00.000Z',nodes=render({observedAt:'2026-09-29T12:00:20.000Z',strategy:{ruleVersion:'current'},diagnostics:{
  schemaVersion:1,source:'local-demo-entry-diagnostics',mode:'demo',ruleVersion:'current',asOf,window:{},
  cycles:{total:1,completed:0,waiting:0,failed:1,incomplete:0},candidates:{eligible:0,total:0},faultReasons:[{reason:'READ_FAILED',count:1}],latest:{pairs:[]}}});
 assert.match(nodes.get('diagnostics-window').textContent,new RegExp(asOf.replaceAll('.','\\.')));
 assert.doesNotMatch(nodes.get('diagnostics-window').textContent,/12:00:20/);
 const failed=render({diagnostics:null,diagnosticsError:'EACCES'});
 assert.match(failed.get('diagnostics-summary').textContent,/讀取失敗.*尚未確認.*EACCES/);
 assert.equal(failed.get('diagnostics-fault').children[0].textContent,'—');
});
