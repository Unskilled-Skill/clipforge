import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutOverlaps, keepTrack } from '../src/audio-tracks.ts';
const roles=['mix','game','voice','desktop','mic'];
test('reopening an explicitly silent export does not re-enable private audio',()=>{
 assert.deepEqual([...withoutOverlaps(new Set(),roles)],[]);
});
test('specific track selection drops overlapping mix and desktop but preserves mic',()=>{
 assert.deepEqual([...withoutOverlaps(new Set([0,1,3,4]),roles)],[1,4]);
 assert.deepEqual([...keepTrack(new Set([0]),1,roles)],[1]);
});
