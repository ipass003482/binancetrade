import { spawnSync } from 'node:child_process';
import { PYTHON } from '../src/engine.mjs';
import { ROOT } from '../src/paths.mjs';
const result=spawnSync(PYTHON,['-m','pytest','test','-q'],{cwd:ROOT,stdio:'inherit',windowsHide:true,shell:false});
if(result.error) throw result.error;
process.exitCode=result.status??1;
