import test from 'node:test';
import assert from 'node:assert/strict';
import { dateBucket, sessionIndices, sessionLabel, libraryRunKey, orderRunItems, runContentsLabel, recordingSessionKey } from '../src/library-groups.ts';

test('generated highlights share the exact source session identity without match metadata', () => {
  const source = recordingSessionKey('LoL Session 2026-10-28 02-26-19.mp4');
  assert.equal(recordingSessionKey('LoL 2K 2026-10-28 02-26-19 (3).mp4'), source);
  assert.equal(recordingSessionKey('LoL 2026-10-28 02-26-19 (1).mp4'), source);
  assert.notEqual(recordingSessionKey('LoL Session 2026-10-28 02-25-58.mp4'), source);
  assert.equal(recordingSessionKey('LoL Session 2026-10-28 02-26-19_trim_0-10.mp4'), null);
});

// Tuesday 27 October 2026, 20:00 local.
const now = new Date(2026, 9, 27, 20, 0).getTime();
const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();

test('recent clips group by day, older ones by week, month, then year', () => {
  assert.deepEqual(dateBucket(at(2026, 9, 27), now), { key: `d:${new Date(at(2026, 9, 27)).toDateString()}`, label: 'Today', recent: true });
  assert.equal(dateBucket(at(2026, 9, 26), now).label, 'Yesterday');
  assert.equal(dateBucket(at(2026, 9, 21), now).recent, true, 'six days ago is still a day');
  // 13 and 15 October share the week starting Monday 12 October.
  const a = dateBucket(at(2026, 9, 13), now);
  const b = dateBucket(at(2026, 9, 15), now);
  assert.equal(a.key, b.key);
  assert.equal(a.recent, false);
  assert.match(a.label, /^Week of /);
  assert.notEqual(dateBucket(at(2026, 9, 11), now).key, a.key, 'Sunday the 11th is the week before');
  const sept = dateBucket(at(2026, 8, 3), now);
  assert.equal(sept.key, dateBucket(at(2026, 8, 29), now).key);
  assert.equal(sept.key, 'm:2026-8');
  assert.equal(dateBucket(at(2025, 1, 2), now).key, 'y:2025');
  assert.equal(dateBucket(at(2025, 11, 30), now).label, '2025');
});

test('a gap of more than two hours starts a new session', () => {
  const h = 3_600_000;
  const times = [now, now - 0.5 * h, now - 2.6 * h, now - 30 * h, now - 31 * h];
  assert.deepEqual(sessionIndices(times), [0, 0, 1, 2, 2]);
  assert.deepEqual(sessionIndices([]), []);
});

test('sessions are named by when they started', () => {
  assert.equal(sessionLabel(at(2026, 9, 27, 19), now), 'This evening');
  assert.equal(sessionLabel(at(2026, 9, 27, 23), now), 'Tonight');
  assert.equal(sessionLabel(at(2026, 9, 27, 1), now), 'Last night');
  assert.equal(sessionLabel(at(2026, 9, 26, 15), now), 'Yesterday afternoon');
  assert.match(sessionLabel(at(2026, 9, 24, 9), now), / morning$/);
  assert.match(sessionLabel(at(2026, 8, 3, 21), now), /, evening$/);
});

test('a known match keeps its group when new clips arrive or another game interrupts', () => {
  assert.equal(libraryRunKey('lol', 'EUW_123', 'early.mp4'), libraryRunKey('lol', 'EUW_123', 'late.mp4'));
  assert.notEqual(libraryRunKey('lol', '123', 'a.mp4'), libraryRunKey('cs2', '123', 'a.mp4'));
  assert.notEqual(libraryRunKey('lol', null, 'unknown.mp4'), libraryRunKey('lol', 'EUW_123', 'known.mp4'));
});

test('expanded matches show highlights in playback order, with recordings last', () => {
  const items = [
    { c: { path: 'full', modified_ms: 400 }, i: 0 },
    { c: { path: 'late', modified_ms: 300 }, i: 1 },
    { c: { path: 'early', modified_ms: 100 }, i: 2 },
  ];
  const ordered = orderRunItems(items, c => c.path === 'full');
  assert.deepEqual(ordered.map(it => it.c.path), ['early', 'late', 'full']);
  assert.deepEqual(ordered.map(it => it.i), [2, 1, 0], 'keyboard indices retain their original clips');
  assert.equal(items[0].c.path, 'full', 'input order is not mutated');
});

test('match summaries distinguish source recordings from highlights', () => {
  assert.equal(runContentsLabel(1, 3), '1 recording · 3 highlights');
  assert.equal(runContentsLabel(0, 1), '1 highlight');
  assert.equal(runContentsLabel(2, 0), '2 recordings');
});
