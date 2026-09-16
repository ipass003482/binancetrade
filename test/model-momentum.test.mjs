import test from 'node:test';
import assert from 'node:assert/strict';
import {modelMomentum} from '../src/model-momentum.mjs';
const B=1789347600000;
const bars=closes=>closes.map((close,i)=>({openTime:B-(4-i)*300000,closeTime:B-(3-i)*300000-1,close}));
test('confirmation requires both observed horizons, symmetric long and short; flat rejects',()=>{
 for(const [closes,long,eligible] of [
  [[99,98,99.5,100],true,true],[[101,102,100.5,100],false,true],
  [[99,98,100.5,100],true,false],[[101,99,99.5,100],true,false],
  [[101,102,99.5,100],false,false],[[99,101,100.5,100],false,false],
  [[100,99,99.5,100],true,false],[[99,98,100,100],true,false]])
  assert.equal(modelMomentum(bars(closes),B,long).eligible,eligible);
});
test('future, shifted, gapped, non-finite or missing close data cannot confirm entry',()=>{
 for(const mutate of [cs=>cs.pop(),cs=>cs[2].openTime++,cs=>cs[3].closeTime++,
  cs=>cs[0].close='NaN',cs=>cs[2].close=true,cs=>cs[0].close=0,
  cs=>cs.push({openTime:B,closeTime:B+299999,close:999})]){
  const cs=bars([99,99,99.5,100]);mutate(cs);
  assert.throws(()=>modelMomentum(cs,B,true));
 }
});
test('only immutable last four closes matter; no in-place editing or future labels',()=>{
 const cs=bars(['99','99.2','99.5','100']),saved=structuredClone(cs);
 const a=modelMomentum(cs,B,true);
 assert.deepEqual(cs,saved);assert.deepEqual(a.closes,['99','99.2','99.5','100']);
 assert.deepEqual(modelMomentum([{close:'irrelevant old row'},...cs],B,true),a);
});
