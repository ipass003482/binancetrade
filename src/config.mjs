import { z } from 'zod';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { readJson } from './io.mjs';
import { modePolicy } from './mode.mjs';
const money = z.string().regex(/^\d+(\.\d{1,8})?$/).refine(v=>Number(v)>0 && Number(v)<=100000);
export const PolicySchema = z.object({
 version:z.literal(1),mode:z.literal('dry-run'),
 pairs:z.array(z.string().regex(/^[A-Z0-9]+\/USDT$/)).min(1).max(10),
 maxStakeUsdt:money,maxExposureUsdt:money,maxOpenTrades:z.number().int().min(1).max(10),
 maxDailyLossUsdt:money,maxEntriesPerDay:z.number().int().min(1).max(100),
 maxSignalAgeSeconds:z.number().int().min(30).max(900),
 maxSpreadBps:z.number().positive().max(100),maxPriceMoveBps:z.number().positive().max(500),intervalSeconds:z.number().int().min(60).max(86400),
 freqtrade:z.object({url:z.string().url(),botName:z.literal('binance-trade-dry'),strategy:z.literal('CodexResearchSpot')}).strict()
}).strict();
export function validatePolicy(input) {
 const p = PolicySchema.parse(input); const u = new URL(p.freqtrade.url);
 if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || u.username || u.password || u.pathname!=='/' || u.search || u.hash)
   throw new Error('Freqtrade must be a dedicated loopback HTTP endpoint');
 if(new Set(p.pairs).size!==p.pairs.length) throw new Error('Duplicate pair');
 return p;
}
export async function loadPolicy(mode='dry-run') { return modePolicy(validatePolicy(await readJson(join(ROOT,'config/policy.json'))),mode); }
export const ProposalSchema = z.object({
 action:z.enum(['hold','buy','sell']),pair:z.string(),stakeUsdt:z.string().regex(/^\d+(\.\d{1,8})?$/),
 snapshotId:z.string().uuid(),evidenceIds:z.array(z.string()).max(10),reason:z.string().min(1).max(1500)
}).strict();
