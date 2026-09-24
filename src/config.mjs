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
 demoSpot:z.object({pairs:z.array(z.string().regex(/^[A-Z0-9]+\/USDT$/)).min(1).max(12).optional(),maxStakeUsdt:money,maxExposureUsdt:money,maxOpenTrades:z.number().int().min(1).max(10),
  maxEntriesPerDay:z.number().int().min(0).max(100),maxDailyLossUsdt:money}).strict().optional(),
 demoFutures:z.object({maxStakeUsdt:money,maxExposureUsdt:money,maxOpenTrades:z.number().int().min(1).max(2),
  maxNotionalUsdt:money,maxTotalNotionalUsdt:money,maxLeverage:z.number().int().min(1).max(3),
  maxDailyLossUsdt:money,maxEntriesPerDay:z.number().int().min(0).max(100)}).strict().optional(),
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
 if(p.demoSpot?.pairs&&new Set(p.demoSpot.pairs).size!==p.demoSpot.pairs.length)throw new Error('Duplicate Demo pair');
 return p;
}
export async function loadPolicy(mode='dry-run') { return modePolicy(validatePolicy(await readJson(join(ROOT,'config/policy.json'))),mode); }
const KevConfirmationSchema=z.object({version:z.literal('kev-two-window-v1'),mode:z.enum(['demo','demo-futures']),pair:z.string().min(1),
 action:z.enum(['buy','open-long','open-short']),snapshotId:z.string().uuid(),boundary:z.number().int().positive(),
 previousBoundary:z.number().int().nonnegative(),intervalMs:z.number().int().positive(),count:z.number().int().min(2),
 confirmed:z.literal(true),firstBoundary:z.number().int().positive(),updatedAt:z.string().min(1)}).strict();
export const ProposalSchema = z.object({
 action:z.enum(['hold','buy','sell']),pair:z.string(),stakeUsdt:z.string().regex(/^\d+(\.\d{1,8})?$/),
 snapshotId:z.string().uuid(),evidenceIds:z.array(z.string()).max(10),reason:z.string().min(1).max(1500),
 kevConfirmation:KevConfirmationSchema.optional()
}).strict();

export const HighFrequencyControlSchema=z.object({
 decision:z.enum(['use','hold']),profile:z.enum(['auto','momentum','mean-reversion','breakout']),
 sensitivity:z.enum(['conservative','balanced','aggressive']),evidenceIds:z.array(z.string()).max(10),
 reason:z.string().min(1).max(600)
}).strict();
export const highFrequencyProposalSchema=policy=>proposalSchema(policy).extend({strategyControl:HighFrequencyControlSchema}).strict();

export const FuturesProposalSchema=ProposalSchema.extend({action:z.enum(["hold","open-long","open-short","close-long","close-short"]),leverage:z.number().int().min(1).max(3)}).strict();
export const proposalSchema=policy=>policy.mode==="demo-futures"?FuturesProposalSchema:ProposalSchema;
