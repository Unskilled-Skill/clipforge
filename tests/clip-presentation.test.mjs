import test from 'node:test';
import assert from 'node:assert/strict';
import { gameName, momentTitle, killBadge, clipKillCount, matchesClipSearch } from '../src/clip-presentation.ts';

test('game names use their familiar spelling', () => {
  assert.equal(gameName('Cs2'), 'Counter-Strike 2');
  assert.equal(gameName('Rainbowsix'), 'Rainbow Six Siege');
  assert.equal(gameName('MyGame'), 'MyGame');
});

test('capture status displays executable names as games and keeps unknown apps readable', () => {
  assert.equal(gameName('valorant-win64-shipping.exe'), 'Valorant');
  assert.equal(gameName('Hunger-Win64-Shipping.exe'), 'Hunger');
  assert.equal(gameName('r5apex_dx12.exe'), 'Apex Legends');
  assert.equal(gameName('unknown-app.exe'), 'unknown-app');
});
test('recording titles surface moments without hiding custom names', () => {
  assert.equal(momentTitle('Cs2 2026-07-01 20-10-00.mp4', 3), 'Counter-Strike 2 · 3 kills');
  assert.equal(momentTitle('My best round.mp4', 3), 'My best round');
  assert.equal(momentTitle('Cs2 Session 2026-07-01 20-10-00.mp4', 0), 'Counter-Strike 2 · Full session');
  assert.equal(killBadge(5), '5K'); // five markers do not establish an ace
  assert.equal(killBadge(1), '1 kill');
  assert.equal(killBadge(0), null);
});

test('real automatic highlight filenames retain their round label', () => {
  assert.equal(momentTitle('Valorant ACE 2026-10-25 22-30-00.mp4', 2), 'Valorant · Ace finish');
  assert.equal(killBadge(2, 'Valorant ACE 2026-10-25 22-30-00.mp4'), 'ACE');
  assert.equal(momentTitle('CS2 3K 2026-10-25 22-30-00.mp4', 0), 'Counter-Strike 2 · 3 kills');
  assert.equal(killBadge(0, 'CS2 3K 2026-10-25 22-30-00.mp4'), '3K');
  assert.equal(killBadge(5, 'My ACE practice.mp4'), '5K');
});


test('kill sorting falls back to a known multikill label without inventing ace contents', () => {
  assert.equal(clipKillCount('CS2 3K 2026-10-25 22-30-00.mp4', 0), 3);
  assert.equal(clipKillCount('Valorant ACE 2026-10-25 22-30-00.mp4', 2), 2);
  assert.equal(clipKillCount('Valorant ACE 2026-10-25 22-30-00.mp4', 0), 0);
});

test('search matches the same readable names and moments displayed on cards', () => {
  assert.ok(matchesClipSearch('Cs2 2026-10-25 22-30-00.mp4', 'Cs2', 3, 'counter-strike'));
  assert.ok(matchesClipSearch('Rainbowsix 2026-10-25 22-30-00.mp4', 'Rainbowsix', 0, 'siege'));
  assert.ok(matchesClipSearch('CS2 3K 2026-10-25 22-30-00.mp4', 'CS2', 0, '3 kills'));
  assert.ok(matchesClipSearch('My clutch.mp4', 'Other', 2, '2K'));
  assert.ok(!matchesClipSearch('My clutch.mp4', 'Other', 2, '3K'));
});

test('edits are titled by their source and what was done', () => {
  assert.equal(momentTitle('Valorant 2026-10-23 02-17-14_discord.mp4', 0), 'Valorant · Discord export');
  assert.equal(momentTitle('CS2 3K 2026-10-25 22-30-00_trim_12-75_discord.mp4', 0), 'Counter-Strike 2 · 3 kills · Trim 0:12–1:15 · Discord export');
  assert.equal(momentTitle('Apex 2026-10-26 14-08-41_gif.gif', 0), 'Apex Legends · GIF');
  assert.equal(momentTitle('Montage_20261026.mp4', 0), 'Montage');
});
