#!/usr/bin/env node
import { runHighFrequencyShadow } from '../src/high-frequency-shadow.mjs';

function options(argv) {
  const result = { cycles: 1, intervalSeconds: 60, aiEveryCycles: 5 };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index], value = argv[++index];
    if (key === '--cycles') result.cycles = Number(value);
    else if (key === '--interval-seconds') result.intervalSeconds = Number(value);
    else if (key === '--ai-every-cycles') result.aiEveryCycles = Number(value);
    else if (key === '--help') return null;
    else throw new Error('INVALID_ARGUMENTS: --cycles N --interval-seconds N --ai-every-cycles N');
  }
  return result;
}

const argv = options(process.argv.slice(2));
if (!argv) console.log('AI high-frequency shadow observer (dry-run only)\n  npm run ai:high-frequency-shadow -- --cycles 1000000 --interval-seconds 60 --ai-every-cycles 5');
else runHighFrequencyShadow(argv)
  .then(value => console.log(JSON.stringify(value, null, 2)))
  .catch(error => { console.error(JSON.stringify({ error: String(error.message ?? error) })); process.exitCode = 1; });
