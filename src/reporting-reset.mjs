import assert from 'node:assert/strict';
import Decimal from 'decimal.js';

const MODES=['demo','demo-futures'];

// A reporting reset may exclude old fills, but may never erase or rewrite them.
export function assertResetHistoryPreserved(previous,histories){
 for(const mode of MODES){
  const source=histories[mode];
  assert.equal(source?.historyComplete,true,`RESET_HISTORY_INCOMPLETE:${mode}`);
  assert.ok(Array.isArray(source.trades),`RESET_HISTORY_MISSING:${mode}`);
  const current=new Map(source.trades.map(t=>[t.trade_id,t]));
  assert.equal(current.size,source.trades.length,`RESET_DUPLICATE_TRADE:${mode}`);
  for(const old of previous[mode]){
   const trade=current.get(old.trade_id);
   assert.ok(trade,`RESET_HISTORY_REMOVED:${mode}:${old.trade_id}`);
   for(const field of ['pair','open_timestamp','enter_tag'])
    assert.equal(trade[field]??null,old[field]??null,`RESET_HISTORY_CHANGED:${mode}:${old.trade_id}:${field}`);
   assert.equal(trade.is_short===true,old.is_short===true,`RESET_HISTORY_CHANGED:${mode}:${old.trade_id}:side`);
   if(!old.is_open){
    assert.equal(trade.is_open,false,`RESET_CLOSED_TRADE_REOPENED:${mode}:${old.trade_id}`);
    assert.equal(trade.close_timestamp,old.close_timestamp,`RESET_HISTORY_CHANGED:${mode}:${old.trade_id}:close`);
    assert.ok(old.profit_abs!==null&&old.profit_abs!==undefined&&trade.profit_abs!==null&&trade.profit_abs!==undefined,
     `RESET_PNL_MISSING:${mode}:${old.trade_id}`);
    const currentPnl=new Decimal(trade.profit_abs),previousPnl=new Decimal(old.profit_abs);
    assert.ok(currentPnl.isFinite()&&previousPnl.isFinite(),`RESET_PNL_INVALID:${mode}:${old.trade_id}`);
    assert.ok(currentPnl.eq(previousPnl),`RESET_PNL_CHANGED:${mode}:${old.trade_id}`);
   }
  }
 }
}

export function assertFreshResetReview(review){
 assert.equal(review?.evidenceComplete,true,'RESET_INITIAL_EVIDENCE_INCOMPLETE');
 assert.equal(review.totalEntries,0,'RESET_INITIAL_COUNT_NOT_ZERO');
 for(const mode of MODES){
  const row=review.modes?.[mode];
  assert.equal(row?.evidenceComplete,true,`RESET_INITIAL_EVIDENCE_INCOMPLETE:${mode}`);
  for(const field of ['entries','openTrades','closedTrades'])
   assert.equal(row[field],0,`RESET_INITIAL_NOT_EMPTY:${mode}:${field}`);
  for(const field of ['netRealizedUsdt','netUnrealizedUsdt']){
   assert.ok(row[field]!==null&&row[field]!==undefined,`RESET_INITIAL_PNL_UNKNOWN:${mode}:${field}`);
   assert.ok(new Decimal(row[field]).eq(0),`RESET_INITIAL_PNL_NOT_ZERO:${mode}:${field}`);
  }
 }
 return review;
}
