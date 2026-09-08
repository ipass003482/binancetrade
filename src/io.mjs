import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function readJson(path) { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/,'')); }
export async function writeJson(path, value) {
  await mkdir(dirname(path), {recursive:true});
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', {flag:'wx',mode:0o600});
  await rename(temp, path);
}
export async function exists(path) {
  try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function lock(path, fn) {
  await mkdir(dirname(path), {recursive:true});
  let fd;
  try { fd = await open(path, 'wx', 0o600); }
  catch (e) { if(e.code==='EEXIST') throw new Error('BUSY_OR_STALE_LOCK: another cycle owns the lock; inspect before recovery'); throw e; }
  try {
    await fd.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()})); await fd.sync();
    return await fn({update:async record=>{
      // Windows cannot always rename over a still-open lock file.
      const data=Buffer.from(JSON.stringify(record));
      await fd.write(data,0,data.length,0);await fd.truncate(data.length);await fd.sync();
    }});
  } finally { await fd.close(); await unlink(path); }
}
export async function journalAppend(path, record) {
  await mkdir(dirname(path), {recursive:true});
  const fd = await open(path,'a',0o600);
  try { await fd.writeFile(JSON.stringify(record)+'\n'); await fd.sync(); } finally { await fd.close(); }
}
export async function journalRead(path) {
  let data;
  try { data = await readFile(path,'utf8'); } catch(e) { if(e.code==='ENOENT') return []; throw e; }
  // A torn write is an error, never silently discarded.
  if(data && !data.endsWith('\n')) throw new Error('JOURNAL_INCOMPLETE: inspect before trading');
  return data.split('\n').filter(Boolean).map(line=>{
   const r=JSON.parse(line);
   if(!r || !/^[a-f0-9]{32}$/.test(r.id??'') || !['pending','unknown','submitted','reconciled','hold','rejected'].includes(r.status)
      || typeof r.at!=='string' || !Number.isFinite(Date.parse(r.at))) throw new Error('JOURNAL_INVALID_RECORD');
   return r;
 });
}
