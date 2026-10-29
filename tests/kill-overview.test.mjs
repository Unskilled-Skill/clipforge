import test from 'node:test';
import assert from 'node:assert/strict';
import { killEvents, clusterKills, adjacentKill, zoomWindow, playingHighlightIndex, alignGeneratedHighlights, clockTicks } from '../src/kill-overview.ts';

const full={clip:{path:'full'},start:100000,end:2500000,full:true};
const first={clip:{path:'first'},start:150000,end:190000};
const second={clip:{path:'second'},start:1200000,end:1250000};
test('source markers are ordered, validated and associated with their saved highlight',()=>{
 const events=killEvents([full,first,second],{full:[NaN,-1,70,1120,2401,70],first:[20]});
 assert.deepEqual(events.map(k=>[k.number,k.at,k.highlightIndex]),[[1,170000,1],[2,1220000,2]]);
});
test('clip-only and virtual highlights use their own marker times without duplicating kills',()=>{
 assert.equal(killEvents([first,{...first,clip:{path:'repeat'}}],{first:[20],repeat:[20]}).length,1);
 const virtual={...first,clip:full.clip,markerTimes:[10],range:[50,90]};
 assert.equal(killEvents([full,virtual],{}).length,1);
 assert.equal(killEvents([full,virtual],{})[0].at,160000);
});
test('long matches cluster dense kills and split them when zoomed',()=>{
 const events=[100,105,110,1200].map((seconds,i)=>({at:seconds*1000,number:i+1}));
 assert.deepEqual(clusterKills(events,0,2400000,800).map(g=>g.events.length),[3,1]);
 assert.deepEqual(clusterKills(events,90000,130000,800).map(g=>g.events.length),[1,1,1]);
});
test('next kill advances past the selected marker even during its lead-in',()=>{
 const events=[60000,120000,180000].map((at,i)=>({at,number:i+1}));
 assert.equal(adjacentKill(events,57000,1,1)?.number,2);
 assert.equal(adjacentKill(events,117000,-1,2)?.number,1);
 assert.equal(adjacentKill(events,0,-1)?.number,undefined);
 assert.equal(adjacentKill(events,180000,1,3),null);
});
test('zoom stays within match bounds and is anchored at the requested moment',()=>{
 assert.deepEqual(zoomWindow(0,2400000,0,2400000,1200000,2),{start:600000,end:1800000});
 assert.deepEqual(zoomWindow(0,2400000,0,1200000,0,2),{start:0,end:600000});
});
test('a chosen kill selects its highlight even when its lead-in overlaps another clip',()=>{
 const clips=[{...full,start:0,end:39000},{...first,start:0,end:10000},{...second,start:8000,end:17000}];
 assert.equal(playingHighlightIndex(clips,2,9600),2);
 assert.equal(playingHighlightIndex(clips,1,12600),2);
 assert.equal(playingHighlightIndex(clips,2,30000),0);
});
test('legacy generated highlight timestamps are aligned using their complete source bookmark sequence',()=>{
 const source={...full,clip:{path:'D:/Clips/full.mp4',name:'LoL Session 2026-10-28 02-26-19.mp4'},start:0,end:1117530};
 const clips=[source,...[1,2,3,4,5].map((n,i)=>({clip:{path:`D:/Clips/${n}.mp4`,name:`LoL ${n===3?'2K ':''}2026-10-28 02-26-19 (${n}).mp4`},start:450000+i*100000,end:450000+i*100000+(n===3?58000:35000)}))];
 const markers={};markers[source.clip.path]=[513.959,710.375,750.86,773.129,856.139,1064.8];
 for(let n=1;n<=5;n++)markers[`D:/Clips/${n}.mp4`]=n===3?[25,47.269]:[25];
 const aligned=alignGeneratedHighlights(clips,markers);
 assert.ok(Math.abs(aligned[1].start-488959)<0.001);
 assert.ok(Math.abs(aligned[3].start-725860)<0.001);
 assert.deepEqual(killEvents(aligned,markers).map(k=>k.highlightIndex),[1,2,3,3,4,5]);
 assert.equal(clips[1].start,450000,'original data is not changed');
 delete markers['D:/Clips/2.mp4'];
 assert.equal(alignGeneratedHighlights(clips,markers),clips,'incomplete data must not guess an alignment');
});

test('clock ticks land on whole minutes of the game clock and never crowd', () => {
  // A 20 minute game whose clock started 45 s into the recording, 1000 px wide.
  const ticks = clockTicks(0, 20 * 60_000, 45_000, 1000);
  assert.deepEqual(ticks.slice(0, 2), [45_000, 165_000]);
  assert.ok(ticks.every((t, i) => i === 0 || (t - ticks[i - 1]) / (20 * 60_000) * 1000 >= 64));
  // Zoomed into 60 s: ticks every 10 s.
  assert.equal(clockTicks(0, 60_000, 0, 1000)[1], 10_000);
});
