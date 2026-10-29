import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPlaybackClips } from '../src/session-playback.ts';

const start = new Date(2026, 9, 28, 2, 26, 19).getTime();
const source = {path:'D:/Clips/LoL Session 2026-10-28 02-26-19.mp4', name:'LoL Session 2026-10-28 02-26-19.mp4', modified_ms:start+1117_530+7000, size_bytes:1749880142};
const highlight = {path:'D:/Clips/LoL 2K 2026-10-28 02-26-19 (3).mp4', name:'LoL 2K 2026-10-28 02-26-19 (3).mp4', modified_ms:start+783_129, size_bytes:1};
const markers = [513.9595337,710.3753504,750.8600416,773.1293405,856.1388896,1064.7998463];

test('session browser uses saved highlights rather than creating duplicate moments', () => {
  const other = {...highlight, path:'D:/Clips/other.mp4',name:'LoL 2026-10-28 01-30-17 (1).mp4'};
  const entries = sessionPlaybackClips(source,[source,other,highlight],{[highlight.path]:{duration:57.3,thumb:'thumb.jpg'}},{},{},1117.53,markers);
  assert.equal(entries.length,2);
  assert.equal(entries[0].full,true);
  assert.equal(entries[0].start,start,'recording start comes from its source stamp, not remux completion');
  assert.equal(entries[1].clip.path,highlight.path);
  assert.match(entries[1].title,/2 kills/);
});

test('sessions without saved highlight files browse virtual moments and edit their source range', () => {
  const entries=sessionPlaybackClips(source,[source],{},{},{},1117.53,markers);
  assert.equal(entries.length,7);
  assert.equal(entries[1].clip.path,source.path);
  assert.notEqual(entries[1].id,entries[2].id);
  assert.deepEqual(entries[1].range,[markers[0]-10,markers[0]+3]);
  assert.equal(entries[1].start,start+(markers[0]-10)*1000);
  assert.deepEqual(entries[1].markerTimes,[10]);
});

test('custom session names retain metadata-based related highlights',()=>{
  const info={id:'match',result:null};
  const entries=sessionPlaybackClips({...source,name:'Custom recording.mp4'},[highlight],{},{[source.path]:{matches:[{info}],rounds:[]},[highlight.path]:{matches:[{info}],rounds:[]}},{},1117.53,markers);
  assert.equal(entries.length,2);
});

test('inconsistent or copied filename dates do not stretch the playback span',()=>{
  const shifted={...source,modified_ms:source.modified_ms+86_400_000};
  const entries=sessionPlaybackClips(shifted,[],{},{},{},1117.53,[]);
  assert.equal(entries[0].end,shifted.modified_ms);
  assert.equal(entries[0].end-entries[0].start,1117_530);
});
