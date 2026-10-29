import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLabel, recordingMatchLabel, roundLabel, matchPlayerFacts, withoutResult } from '../src/match-presentation.ts';
import { sessionEntries, recentSessions, latestClipForExport } from '../src/studio-data.ts';
const info={id:'match',game:'cs2.exe',source:'cs2-gsi',map:'de_nuke',mode:'competitive',score:{won:13,lost:9},result:'won',round_results:{}};

test('match player facts show source stats and keep missing values absent',()=>{
  assert.deepEqual(matchPlayerFacts(undefined),[]);
  const facts=matchPlayerFacts({champion:'Lissandra',kills:6,deaths:14,assists:18,cs:39,gold:15966,champion_damage:30186,vision_score:0,finalized:true});
  assert.equal(facts.find(f=>f.label==='Champion'),undefined);
  assert.equal(facts.find(f=>f.label==='K / D / A').value,'6 / 14 / 18');
  assert.equal(facts.find(f=>f.label==='Damage').value,(30186).toLocaleString());
  // ARAM tracks no vision: a 0 is left out, a real score is kept.
  assert.equal(facts.find(f=>f.label==='Vision'),undefined);
  assert.equal(matchPlayerFacts({vision_score:12}).find(f=>f.label==='Vision').value,'12');
  assert.deepEqual(matchPlayerFacts({kills:0,deaths:null,assists:null}),[]);
});
test('a label without its result keeps the score',()=>{
  assert.equal(withoutResult('Nuke · competitive · Won 13–9'),'Nuke · competitive · 13–9');
  assert.equal(withoutResult('Howling Abyss · ARAM: Mayhem · Lost'),'Howling Abyss · ARAM: Mayhem');
  assert.equal(withoutResult('Wonderland · Draw'),'Wonderland');
});
test('match labels display reported outcomes and never infer a win from a partial score',()=>{
  assert.equal(matchLabel(info),'Nuke · competitive · Won 13–9');
  assert.equal(matchLabel({...info,result:null}),'Nuke · competitive · 13–9');
  assert.equal(recordingMatchLabel(undefined),'');
});
test('persisted session identity survives a custom filename',()=>{
  const clips=[{path:'custom',name:'My best match.mp4',modified_ms:2},{path:'clip',name:'Saved clip.mp4',modified_ms:1}];
  const metadata={custom:{version:1,is_session:true,matches:[],rounds:[]}};
  assert.equal(recentSessions(clips,3,metadata)[0].path,'custom');
  assert.equal(latestClipForExport(clips,metadata).path,'clip');
});
test('round navigation uses reported boundaries and keeps rounds without kills',()=>{
  const metadata={version:1,is_session:true,matches:[{start:0,end:40,info}],rounds:[{match_id:'match',number:9,start:0,end:20,result:'won'},{match_id:'match',number:10,start:20,end:40,result:null}]};
  const entries=sessionEntries([4,12,12,50],35,metadata);
  assert.deepEqual(entries.map(e=>({label:e.label,start:e.start,end:e.end,kills:e.times.length,result:e.result})),[{label:'Round 9',start:0,end:20,kills:2,result:'won'},{label:'Round 10',start:20,end:35,kills:0,result:null}]);
  assert.equal(roundLabel(metadata,20),'Round 10');
  assert.equal(roundLabel(metadata,40),'');
});
