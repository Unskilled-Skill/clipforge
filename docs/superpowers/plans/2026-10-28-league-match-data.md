# League match data and installed update

User approved: link League recordings to their matches, save mode/result/player stats, and update the installed Windows app with all current UI changes.

- Capture live context independently of auto-clipping and persist player-only snapshots.
- Finalize from the authenticated local League client's match history, matching the current player's identity and a completed game. Use stable game IDs; never derive a result from kill totals.
- Repair recordings and generated highlights using bounded recording/match overlap and exact recorder family identity, including the latest existing match. Preserve unrelated files and other-game metadata.
- Show champion, K/D/A, CS, gold and champion damage with map/mode/result; keep old sidecars readable.
- Verify parsers, negative matching cases, sidecar repair, frontend build and UI. Build the installer before stopping the app, then install locally and verify binary replacement and recovered metadata. No public release.

Latest actual history was retrieved read-only from the signed-in League client. Sanitized fixtures retain game/stat shape with synthetic player identities. Credentials remain in memory and are never logged or saved.

Verification completed:
- 50 Node tests passed; Rust library tests: 76 passed, 8 existing tests ignored.
- Production frontend build and NSIS Windows release bundle succeeded.
- Installed v0.1.49 locally (installer exit 0), relaunched, and confirmed the installed executable version. Installed/build binary bytes differ only in the expected Tauri bundle marker (NSS versus UNK).
- The installed worker fetched local League history and repaired the actual latest session plus all five highlights to league-na1-5668632195. All six sidecars agree on Howling Abyss, ARAM: Mayhem, lost, Lissandra, 6/14/18, 39 CS, 15,966 gold and 30,186 champion damage.
- Raised the installed app and visually confirmed its real library shows two compact League match rows with recovered champion/KDA summaries. Windows integrity prevents automated clicks inside the elevated native window; the player stats layout was checked in the browser at 960×620 with no horizontal overflow.
- Capture settings and video/marker files were not changed. No public release or push was performed.

Live capture and post-match history have separate lifecycles. Cached final summaries contain no credentials or account identities, and repairs skip ambiguous matches and multi-match recordings. A fresh live match still needs end-to-end validation of the polling lifecycle; the completed-match fetch, repair and installed-library display were verified with the real finished game.
