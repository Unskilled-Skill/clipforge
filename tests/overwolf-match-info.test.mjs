import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const context = {};
runInNewContext(readFileSync(new URL('../overwolf/match-info.js', import.meta.url), 'utf8'), context);
const merge = (state, update) => JSON.parse(JSON.stringify(context.ClipForgeMatchInfo.merge(state,update)));
test('Overwolf merges delta match info without forwarding personal roster fields', () => {
  let state = merge({}, {info:{match_info:{map:'Jam',roster:'private',score:'{"won":9,"lost":2}'}}});
  state = merge(state,{category:'match_info',key:'round_number',value:'12'});
  assert.deepEqual(state,{map:'Jam',score:{won:9,lost:2},round_number:12});
});
test('new maps and IDs cannot carry scores or results from the previous match', () => {
  const old={map:'Jam',score:{won:13,lost:9},match_outcome:'victory',pseudo_match_id:'old'};
  assert.deepEqual(merge(old,{info:{match_info:{map:'Triad'}}}),{map:'Triad'});
  assert.deepEqual(merge(old,{info:{match_info:{pseudo_match_id:'new'}}}),{pseudo_match_id:'new'});
  const next=merge(old,{info:{match_info:{round_phase:'shopping',round_number:'1'}}});
  assert.equal(next.score,undefined); assert.equal(next.match_outcome,undefined); assert.equal(next.map,'Jam');
});
test('empty map reset after match end preserves context for a late outcome', () => {
  const old={map:'Jam',round_phase:'game_end'};
  const next=merge(old,{info:{match_info:{map:'',match_outcome:'defeat'}}});
  assert.equal(next.map,'Jam'); assert.equal(next.match_outcome,'defeat');
});

test('companion reload reads an existing match snapshot and then merges updates', async () => {
  const sent = [];
  let onInfo;
  const listener = { addListener() {} };
  const runtime = {
    console, AbortController, setTimeout, clearTimeout, setInterval() {},
    fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); },
    overwolf: { games: {
      getRunningGameInfo(callback) { callback({id:216400,isRunning:true}); },
      onGameInfoUpdated: listener,
      events: {
        setRequiredFeatures(_features, callback) { callback({success:true,supportedFeatures:[]}); },
        getInfo(callback) { callback({success:true,res:{match_info:{map:'Jam',round_number:'9',roster:'private'}}}); },
        onNewEvents: listener,
        onInfoUpdates2: { addListener(callback) { onInfo = callback; } },
      },
    } },
  };
  runInNewContext(readFileSync(new URL('../overwolf/match-info.js', import.meta.url), 'utf8'), runtime);
  runInNewContext(readFileSync(new URL('../overwolf/background.js', import.meta.url), 'utf8'), runtime);
  onInfo({gameId:21640,info:{match_info:{score:'{"won":5,"lost":3}'}}});
  await new Promise(resolve => setImmediate(resolve));
  const snapshots = sent.filter(message => message.type === 'match_info');
  assert.deepEqual(snapshots[0].info,{map:'Jam',round_number:9});
  assert.deepEqual(snapshots.at(-1).info,{map:'Jam',round_number:9,score:{won:5,lost:3}});
});
