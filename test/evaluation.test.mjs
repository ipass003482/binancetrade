import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateSavedHistory } from '../src/evaluation.mjs';
import { readJson,writeJson } from '../src/io.mjs';
const temp=()=>mkdtemp(join(tmpdir(),'binance-evaluation-'));
test('offline evaluation copies exact input, hashes it, and keeps older trades unversioned',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('offline evaluation must not use network'));
 const local=await temp(),input=join(local,'trade-history.json');
 const history={mode:'demo',observedAt:'2026-09-09T01:00:00Z',trades:[
  {trade_id:1,pair:'BTC/USDT',is_open:false,is_short:false,leverage:1,trading_mode:'spot',stake_amount:100,
   open_timestamp:Date.parse('2026-09-09T00:00:00Z'),close_timestamp:Date.parse('2026-09-09T00:30:00Z'),profit_abs:2}
 ]};
 await writeJson(input,history);const result=await evaluateSavedHistory({local,mode:'demo'});
 const report=await readJson(result.json),bytes=await readFile(input);
 assert.equal(report.source.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.deepEqual(await readFile(join(result.json,'..','input-history.json')),bytes);
 assert.equal(report.performance.summary.netRealizedUsdt,'2');
 assert.equal(report.performance.currentVersion.summary.closedTrades,0);
 assert.equal(report.performance.cohorts.version[0].key,'unversioned');
 assert.equal(report.performance.assessment.promotionAuthorized,false);
 assert.equal(report.historyFresh,false);
 assert.ok((await readFile(result.markdown,'utf8')).includes('目前版本評估'));
});
test('offline evaluation refuses cross-mode, future-dated and malformed histories',async()=>{
 const local=await temp(),file=join(local,'trade-history.json');
 for(const [history,pattern] of [
  [{mode:'demo-futures',observedAt:'2026-09-09T00:00:00Z',trades:[]},/MODE_MISMATCH/],
  [{mode:'demo',observedAt:'invalid',trades:[]},/HISTORY_INVALID/],
  [{mode:'demo',observedAt:'2999-01-01T00:00:00Z',trades:[]},/HISTORY_INVALID/],
  [{mode:'demo',observedAt:'2026-09-09T00:00:00Z',trades:{}},/HISTORY_INVALID/]
 ]){await writeJson(file,history);await assert.rejects(evaluateSavedHistory({local,mode:'demo'}),pattern);}
});
