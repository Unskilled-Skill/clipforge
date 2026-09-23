import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSetupSample } from '../src/setup-check.ts';

test('prepares only the path returned by its own save request', async () => {
  const path = await captureSetupSample({
    save: async () => 'C:/clips/requested.mp4',
    prepare: async (input) => { assert.equal(input, 'C:/clips/requested.mp4'); return 'C:/clips/sample.mp4'; },
  });
  assert.equal(path, 'C:/clips/sample.mp4');
});

test('failed saves report the error without preparing a sample', async () => {
  let prepared = false;
  await assert.rejects(captureSetupSample({
    save: async () => { throw new Error('OBS disconnected'); },
    prepare: async () => { prepared = true; return 'unused'; },
  }), /OBS disconnected/);
  assert.equal(prepared, false);
});

test('unfinished save times out instead of claiming success', async () => {
  await assert.rejects(captureSetupSample({
    save: () => new Promise(() => {}),
    prepare: async () => 'unused',
  }, 10), /timed out/i);
});

test('sample preparation failures remain failures', async () => {
  await assert.rejects(captureSetupSample({
    save: async () => 'clip.mp4',
    prepare: async () => { throw new Error('ffmpeg failed'); },
  }), /ffmpeg failed/);
});

test('sample preparation also has a deadline', async () => {
  await assert.rejects(captureSetupSample({
    save: async () => 'clip.mp4',
    prepare: () => new Promise(() => {}),
  }, 10), /timed out/i);
});
