# Highlight browser implementation plan

Goal: make the match view primarily for finding and watching highlights, as requested and approved in chat.

Keep the existing React/Tauri playback, full recording support, round navigation, stars and editor entry point. Replace the dense four-lane timeline with a scrollable thumbnail strip. Use neutral kill ticks and teal selection. Include thumbnail size controls and a separate source playback scrubber so missing match time is never represented as continuous footage.

- [x] Replace match timeline and remove waveform generation and timeline mapping.
- [x] Add accessible thumbnail selection, kill seeking, size controls and current-highlight scrolling.
- [x] Style the strip at desktop and minimum window sizes; remove duplicate clip sidebar while preserving rounds.
- [x] Run production build, existing tests, design detector and browser interaction checks.

Review full-recording-only, many clips, absent thumbnails/markers, keyboard access, and playback across clip boundaries. No backend changes or release publishing.

Validation: production build passed (existing bundle-size advisory); all 40 Node tests passed; diff whitespace check passed. Browser checks used the existing app preview and a temporary 23-highlight fixture at 1440×900 and 960×620: selection, horizontal overflow, current highlight visibility, size range, playback, kill seek, keyboard seek and editor callback. Full-match seeks against real recordings remain unverified because the browser fixture uses a short sample video. The design detector reported only existing font and border styles outside this change.

Follow-up approved in chat: match names now open the browser directly; an explicit Show files action reveals raw clips. Single recordings and reported single-clip matches also receive match entries. The empty file inspector no longer takes space until a visible file is selected. Browser search and Multikills only combine without changing playback. All 44 Node tests passed; browser checks confirmed file reveal/hide, direct opening, multikill filtering, empty-search recovery and no page overflow at 960×620. Preview uses browser fixtures and does not change native capture settings.

Real-recording review: LoL Session 2026-10-28 02-26-19.mp4 probes as 1117.53 s, 1920×1080 AV1 at 30 fps, 1,749,880,142 bytes and four AAC tracks. Gameplay frames at 60 s and 900 s and a 12 s audio sample at 500 s were inspected. Six source markers match the five generated clips (1, 1, 2, 1, 1 kills). No recording metadata sidecar exists for this session; no match result is inferred. The installed executable predates this UI work.

Recent-session navigation now adapts to MatchView, using actual saved highlights when available and in-memory marker moments otherwise. Source filename stamps group related generated files even without match metadata. The session adapter preserves per-file stars and virtual-highlight trim ranges. A poster makes the initial player view useful before playback. Regression checks cover real-shaped League filenames, source timing versus remux completion, saved versus virtual moments, custom metadata-based names and copied/inconsistent date stamps.

Final review validation: 49 Node tests passed and production build passed. Running the shared session adapter against the actual files produced one full source plus five highlights labelled 1, 1, 2, 1, 1 kills; every highlight fits within the source recording. Browser checks confirmed Recent sessions opens the shared player, saved highlight clips are used, and marker-only sessions render unique virtual entries without console errors. Windows native app inspection was limited by its elevated integrity; no installed-app update or capture setting change was performed.
