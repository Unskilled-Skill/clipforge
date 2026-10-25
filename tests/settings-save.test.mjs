import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeWrites } from '../src/settings-save.ts';

test('settings writes finish in request order even when changes are made rapidly', async () => {
  const calls = []; let release;
  const firstDone = new Promise(resolve => { release = resolve; });
  const save = serializeWrites(async value => { calls.push(value); if(value === 1) await firstDone; });
  const first = save(1); const second = save(2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls,[1]);
  release(); await Promise.all([first,second]);
  assert.deepEqual(calls,[1,2]);
});
test('a rejected settings write does not stop retry or later changes', async () => {
  const calls=[];
  const save=serializeWrites(async value=>{calls.push(value);if(value===1) throw new Error('disk read-only');});
  const failed=assert.rejects(save(1),/read-only/); const next=save(2);
  await Promise.all([failed,next]); assert.deepEqual(calls,[1,2]);
});
test('fire-and-forget UI saves are handled while awaited callers still receive failures', async () => {
  const save=serializeWrites(async()=>{throw new Error('not writable');});
  save('ignored by event handler');
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(save('awaited by form'),/not writable/);
});

import { createSettingsWriter } from '../src/settings-save.ts';
test('queued field edits preserve engine changes and return backend normalization', async () => {
  let backend={enabled:false,games:['cs2.exe'],quality:60};
  const save=createSettingsWriter(async()=>structuredClone(backend),async value=>{backend={...value,games:value.games.map(g=>g.trim().toLowerCase())};});
  const before=structuredClone(backend);
  backend.games.push('learned.exe');
  const one=save(before,{...before,enabled:true});
  const two=save({...before,enabled:true},{...before,enabled:true,quality:30});
  await one; const canonical=await two;
  assert.deepEqual(canonical,{enabled:true,games:['cs2.exe','learned.exe'],quality:30});
  assert.deepEqual(await save(canonical,{...canonical,games:[' NEW.EXE ']}),{enabled:true,games:['new.exe'],quality:30});
});
test('retry and subsequent edits retain failed fields without overwriting engine changes', async () => {
  let backend={enabled:false,games:['cs2.exe'],quality:60}; let fail=true;
  const save=createSettingsWriter(async()=>structuredClone(backend),async value=>{if(fail) throw new Error('read only');backend=value;});
  const before=structuredClone(backend); const optimistic={...before,enabled:true};
  await assert.rejects(save(before,optimistic),/read only/);
  backend.games.push('learned.exe'); fail=false;
  const next={...optimistic,quality:30};
  assert.deepEqual(await save(optimistic,next),{enabled:true,games:['cs2.exe','learned.exe'],quality:30});
  assert.deepEqual(await save(next,next),backend);
});
test('successful reset discards retained failed edits before the next change', async () => {
 let backend={enabled:false,quality:60}; let fail=true;
 const save=createSettingsWriter(async()=>({...backend}),async value=>{if(fail)throw new Error('read only');backend=value;});
 await assert.rejects(save(backend,{...backend,enabled:true}));
 fail=false; backend={enabled:false,quality:60}; save.reset();
 assert.deepEqual(await save(backend,{...backend,quality:30}),{enabled:false,quality:30});
});
