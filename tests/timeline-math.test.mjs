import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMarkers, rulerTicks, snapTime } from '../src/timeline/math.ts';

test('kills close together on screen share one pill, and split when zoomed', () => {
  const kills = [10, 11, 12.5, 40];
  const wide = groupMarkers(kills, 120, 600); // 5 px per second
  assert.deepEqual(wide.map((g) => g.times), [[10, 11, 12.5], [40]]);
  assert.equal(wide[0].t, 10);
  const zoomed = groupMarkers(kills, 120, 6000); // 50 px per second
  assert.equal(zoomed.length, 4);
});

test('ruler majors never crowd, at any zoom', () => {
  for (const width of [400, 1200, 12000]) {
    const majors = rulerTicks(180, width).filter((t) => t.major);
    for (let i = 1; i < majors.length; i++) assert.ok(majors[i].x - majors[i - 1].x >= 90);
  }
});

test('snap latches in at 10px and lets go only past 18px', () => {
  const pps = 10; // px per second
  let r = snapTime(5.5, [5], null, pps); // 5px away: snaps
  assert.deepEqual(r, { t: 5, latched: 5 });
  r = snapTime(6.5, [5], r.latched, pps); // 15px: still held
  assert.equal(r.t, 5);
  r = snapTime(7, [5], r.latched, pps); // 20px: released
  assert.deepEqual(r, { t: 7, latched: null });
});
