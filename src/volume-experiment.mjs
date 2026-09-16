// Host-owned, preregistered forward experiment. No optimization or order calls.
import {join} from 'node:path';
import {z} from 'zod';
import {ROOT} from './paths.mjs';
import {readJson} from './io.mjs';

export const VOLUME_EXPERIMENT_VERSION='volume-forward-v1';
export const VOLUME_ARMS=Object.freeze([
 Object.freeze({arm:'vol-08',minimum:0.8}),
 Object.freeze({arm:'vol-10',minimum:1.0}),
 Object.freeze({arm:'vol-12',minimum:1.2})
]);
export const VOLUME_BLOCK_MS=6*3600000;
export const VOLUME_DURATION_MS=72*3600000;
const Config=z.object({version:z.literal(1),enabled:z.boolean(),startAt:z.string().datetime()}).strict();
export function validateVolumeConfig(value){
 const c=Config.parse(value),start=Date.parse(c.startAt);
 if(!Number.isSafeInteger(start)||start%300000)throw Error('VOLUME_EXPERIMENT_START_INVALID');
 return c;
}
export async function loadVolumeExperiment(){return validateVolumeConfig(await readJson(join(ROOT,'config/volume-experiment.json')));}
export function volumeAssignment(boundary,config){
 const c=validateVolumeConfig(config);
 if(!Number.isSafeInteger(boundary)||boundary%300000)throw Error('VOLUME_EXPERIMENT_BOUNDARY_INVALID');
 const start=Date.parse(c.startAt),end=start+VOLUME_DURATION_MS;
 if(!c.enabled||boundary<start||boundary>=end)return null;
 const blockIndex=Math.floor((boundary-start)/VOLUME_BLOCK_MS),choice=VOLUME_ARMS[blockIndex%VOLUME_ARMS.length];
 return {version:VOLUME_EXPERIMENT_VERSION,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),
  candleBoundary:boundary,blockIndex,...choice};
}
export function validateVolumeAssignment(value,boundary){
 if(value===undefined||value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('VOLUME_EXPERIMENT_ASSIGNMENT_INVALID');
 const expected=volumeAssignment(boundary,{version:1,enabled:true,startAt:value.startAt});
 if(!expected||Object.keys(value).length!==Object.keys(expected).length||
  Object.entries(expected).some(([k,v])=>value[k]!==v))throw Error('VOLUME_EXPERIMENT_ASSIGNMENT_INVALID');
 return expected;
}
export function assertVolumeAssignment(snapshot,config){
 const expected=volumeAssignment(snapshot.candleBoundary,config);
 const actual=validateVolumeAssignment(snapshot.volumeExperiment,snapshot.candleBoundary);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('VOLUME_EXPERIMENT_HOST_MISMATCH');
 return expected;
}
export function volumeMinimum(snapshot){return validateVolumeAssignment(snapshot?.volumeExperiment,snapshot?.candleBoundary)?.minimum??0.8;}
export function volumeVariant(value){return value?`atr15m-forward-v10/${VOLUME_EXPERIMENT_VERSION}/${value.arm}`:'atr15m-forward-v10';}
export function isVolumeVariant(value){return VOLUME_ARMS.some(a=>['atr15m-forward-v8','atr15m-forward-v9','atr15m-forward-v10'].some(v=>value===`${v}/${VOLUME_EXPERIMENT_VERSION}/${a.arm}`));}
