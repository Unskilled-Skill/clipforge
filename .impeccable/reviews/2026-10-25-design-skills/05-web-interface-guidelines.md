# 05 — Web Interface Guidelines

Rules fetched fresh on25October2026 from https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md . Existing desktop React/Tauri UI reviewed; no source modifications.

## src/panels.tsx

- src/panels.tsx:1149 — [P2, browser verified] Per-keystroke trim/filter drops an empty newline; Enter cannot add a watched-game row. Keep an unnormalized editing draft.
- src/panels.tsx:1143 — [P3] Executable textarea lacks spellCheck=false/autocomplete metadata.
- src/panels.tsx:785 — [P2] Capture and most Settings section titles are spans, missing heading navigation.
- src/panels.tsx:176 — [P2] Scrollable dialogs lack overscroll containment.
- src/panels.tsx:406 — [P2] Backup failure text lacks local retry guidance/live announcement.

## src/App.tsx

- src/App.tsx:2184 — [P2, browser verified] Reduced-motion still mounts muted autoplay looping hover video. Provide the still alternative.
- src/App.tsx:2335 — [P2] Montage reordering is drag-only; expose move earlier/later keyboard controls. Selection-order rebuilding is a cumbersome workaround.
- src/App.tsx:2427 — [P2] Editor identity is a button without a page heading; keep Rename within semantic heading structure.
- src/App.tsx:1861 — [P3] No skip-to-main link; repeated sidebar controls precede content.

## src/App.css / index.html

- src/App.css:1 — [P2, browser verified] Dark UI computes color-scheme:normal; declare the intended native-control theme.
- src/App.css:2019 — [P2] Decorative edge motion persists under reduced motion; shared with Emil review.
- index.html:3 — [P3] Missing theme-color metadata; limited practical impact in the undecorated desktop shell.

## Context / exclusions

Native window navigation does not require a web router or URL-encoded filters. No SSR hydration, phone safe-area or remote-font-preconnect issue applies. Existing parent aspect-ratio boxes stabilize thumbnails despite missing intrinsic img dimensions; no CLS incident was established. Current labels, explicit select colors, alert/status roles, lazy thumbnails and content-visibility are useful passes. Decorative icon semantics need a rendered accessibility-tree audit before claiming duplicate announcements.

Browser evidence: emulated reduce still produced autoplay=true,loop=true,muted=true,controls=false hover video. Watched textarea before/after Enter was identical (3lines); lineAdded=false. colorScheme=normal. These are direct observations; real screen-reader behavior and physical hybrid-input testing were not performed.

