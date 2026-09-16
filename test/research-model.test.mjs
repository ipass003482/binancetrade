import test from 'node:test';
import assert from 'node:assert/strict';
import { modelArgs,RESEARCH_MODEL } from '../src/codex.mjs';
test('all research invocations explicitly select Sol instead of inheriting a default',()=>{
 assert.equal(RESEARCH_MODEL,'gpt-5.6-sol');
 assert.deepEqual(modelArgs(),['--model','gpt-5.6-sol']);
});
