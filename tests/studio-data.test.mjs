import test from 'node:test';
import assert from 'node:assert/strict';
import { recentSessions, latestClipForExport, sessionMoments, filterCommands } from '../src/studio-data.ts';

test('recent sessions exclude regular clips and edits, sort newest first without changing input', () => {
  const clips = [
    { path: 'old', name: 'Valorant Session 2026-10-24 20-00-00.mp4', modified_ms: 1 },
    { path: 'clip', name: 'Valorant 2026-10-26 20-00-00.mp4', modified_ms: 9 },
    { path: 'new', name: 'Cs2 Session 2026-10-26 20-00-00.mp4', modified_ms: 3 },
    { path: 'edit', name: 'My Session highlight.mp4', modified_ms: 10 },
    { path: 'trim', name: 'Valorant Session 2026-10-26 20-00-00_trim_13-26.mp4', modified_ms: 11 },
    { path: 'export', name: 'Valorant Session 2026-10-26 20-00-00_discord.mp4', modified_ms: 12 },
  ];
  assert.deepEqual(recentSessions(clips, 1).map(c => c.path), ['new']);
  assert.equal(latestClipForExport(clips).path, 'edit'); // a custom name remains a normal clip
  assert.deepEqual(clips.map(c => c.path), ['old', 'clip', 'new', 'edit', 'trim', 'export']);
});

test('export latest skips exports and full sessions even when they are the newest files', () => {
  const clips = [
    {path:'clip',name:'Valorant 2026-10-26 20-00-00.mp4',modified_ms:1},
    {path:'session',name:'Valorant Session 2026-10-26 20-00-00.mp4',modified_ms:2},
    {path:'export',name:'Valorant 2026-10-26 20-00-00_discord.mp4',modified_ms:3},
    {path:'trim',name:'Valorant 2026-10-26 20-00-00_trim_10-20.mp4',modified_ms:4},
  ];
  assert.equal(latestClipForExport(clips).path,'clip');
  assert.equal(latestClipForExport(clips.slice(1)),undefined);
});

test('session moments group nearby kills and keep clip windows inside the recording', () => {
  assert.deepEqual(sessionMoments([99, 4, 12, 12, NaN, -1, 120], 100), [
    { times: [4, 12], start: 0, end: 15 },
    { times: [99], start: 89, end: 100 },
  ]);
  assert.deepEqual(sessionMoments([1], 0), []);
});

test('a long chain of kills cannot produce a moment longer than two minutes', () => {
  const moments = sessionMoments(Array.from({length: 30}, (_, i) => 20 + i * 10), 400);
  assert.equal(moments.length, 3);
  assert.ok(moments.every(m => m.end - m.start <= 120));
  assert.equal(moments.reduce((sum, m) => sum + m.times.length, 0), 30);
});

test('command queries match every word across action labels and clip metadata', () => {
  const commands = [{label: 'Open ace finish', keywords:'Valorant clip'}, {label:'Export selected clip', keywords:'Discord 10 MB'}];
  assert.deepEqual(filterCommands(commands, '  VALORANT ace '), [commands[0]]);
  assert.deepEqual(filterCommands(commands, 'discord export'), [commands[1]]);
  assert.deepEqual(filterCommands(commands, 'valorant discord'), []);
  assert.equal(filterCommands(commands, '').length, 2);
});
