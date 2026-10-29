# Player kill navigation

Approved in chat: add kill markers, saved-highlight ranges, hover previews, grouped markers for crowded timelines, zoom, previous/next-kill navigation and synchronized filters to the shared player; update the installed app.

- Keep the timeline on actual match time. Seek from markers with three seconds of lead-in, preserving pause/play state. Group by screen spacing and expose individual moments in an accessible chooser.
- Share search/multikill filters with the thumbnail strip. Prefer source recording markers to repeated clip markers; validate all times and avoid duplicates.
- Preview from saved clip thumbnails or the cached filmstrip; keep round boundaries when reported. No new capture or metadata behavior.
- Verify pure mapping/clustering/navigation tests, browser interactions at desktop/minimum sizes, production build, then build/install v0.1.50 and verify the installed binary and real library.

Implementation and verification:
- Added KillOverview and pure event/group/zoom/selection helpers. Full-recording markers take precedence; clip-only fallback and virtual moments retain their own times. Invalid times and duplicate markers are excluded.
- Clusters expose individual kills and a direct zoom into the cluster. Seek-bar ranges, round cues, focus/hover thumbnail previews, previous/next controls and Alt+Left/Right shortcuts share match time.
- Shared highlight filters affect timeline markers/ranges and thumbnail results together. Chosen kills prefer their corresponding highlight during overlapping lead-ins.
- 57 Node tests pass. Browser checks verified preview on focus, grouped chooser, direct zoom splitting, keyboard navigation, three-second lead-in, paused/playing state preservation, correct highlight selection, and combined/empty filters.
- A synthetic 40-minute match with 200 kills produced 17 non-overlapping marker groups at 960px; the page had no horizontal overflow.
- Verified the real 18:37 League recording: all six source kills map to its five saved highlights. Legacy generated clip ranges are aligned only when complete source and child bookmark sequences agree; incomplete/ambiguous sets retain their original positions. Recordings and marker files are not modified.
- Windows update target is v0.1.50. Capture, match metadata and recording files are unchanged by this feature.

- Final native release build and NSIS bundle succeeded for v0.1.50. Installation waits for the user to exit the elevated v0.1.49 process; Windows denies this session access to close it.
