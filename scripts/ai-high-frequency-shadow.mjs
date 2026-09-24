#!/usr/bin/env node
import { runHighFrequencyShadow } from '../src/high-frequency-shadow.mjs';
import { resolve } from 'node:path';

function options(argv) {
  const result = { cycles: 1, intervalSeconds: 60, aiEveryCycles: 5 };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--no-ai') { result.aiEnabled = false; continue; }
    if (key === '--help') return null;
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT_VALUE: ' + key);
    if (key === '--cycles') result.cycles = Number(value);
    else if (key === '--interval-seconds') result.intervalSeconds = Number(value);
    else if (key === '--ai-every-cycles') result.aiEveryCycles = Number(value);
    else if (key === '--local') result.local = resolve(value);
    else throw new Error('INVALID_ARGUMENTS: --cycles N --interval-seconds N --ai-every-cycles N --no-ai --local PATH');
  }
  return result;
}

const argv = options(process.argv.slice(2));
if (!argv) console.log('AI high-frequency shadow observer (dry-run only)\n  npm run ai:high-frequency-shadow -- --cycles 1000000 --interval-seconds 60 --ai-every-cycles 5\n  Public-data smoke, no model or synthetic signals: --cycles 1 --no-ai --local work/shadow-v2-smoke');
else runHighFrequencyShadow(argv)
  .then(value => console.log(JSON.stringify(value, null, 2)))
  .catch(error => { console.error(JSON.stringify({ error: String(error.message ?? error) })); process.exitCode = 1; });
