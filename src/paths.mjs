import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL = join(ROOT, 'local');
export const RESEARCH = join(ROOT, 'research');
