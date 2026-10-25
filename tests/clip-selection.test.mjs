import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem } from '../src/clip-selection.ts';
test('montage moves preserve clips and their explicit order without mutating input',()=>{
 const clips=['a','b','c']; assert.deepEqual(moveItem(clips,2,0),['c','a','b']); assert.deepEqual(moveItem(clips,0,2),['b','c','a']); assert.deepEqual(clips,['a','b','c']);
});
test('invalid montage movement never inserts an undefined or drops a clip',()=>{
 for(const [from,to] of [[-1,0],[3,0],[0,3],[0,-1]]) assert.deepEqual(moveItem(['a','b','c'],from,to),['a','b','c']);
 assert.deepEqual(moveItem([],0,0),[]);
});
