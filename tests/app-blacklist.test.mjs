import test from "node:test";
import assert from "node:assert/strict";
import { blacklistApp } from "../src/app-blacklist.ts";

test("blocking a full executable path removes an existing watched app and deduplicates", () => {
  const settings = { game_exes: ["Spotify.EXE", "cs2.exe"], game_blacklist: ["spotify.exe"] };
  const next = blacklistApp(settings, ' "C:\\Apps\\Spotify.EXE" ');
  assert.deepEqual(next.game_exes, ["cs2.exe"]);
  assert.deepEqual(next.game_blacklist, ["spotify.exe"]);
  assert.deepEqual(settings.game_exes, ["Spotify.EXE", "cs2.exe"]);
});

test("invalid executable names cannot enter the blacklist", () => {
  for (const name of ["", "   ", "*.exe", "spotify", "C:\\Apps\\", ".exe"]) {
    assert.throws(() => blacklistApp({ game_exes: [], game_blacklist: [] }, name));
  }
});

test("Discord variants are already excluded and cannot become removable entries", () => {
  for (const exe of ["Discord.exe", "DISCORDPTB.EXE", "discordcanary.exe"]) {
    assert.throws(() => blacklistApp({ game_exes: [], game_blacklist: [] }, exe), /already excluded/);
  }
});
