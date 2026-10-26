# Studio Reference Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish existing ClipForge screens against the supplied Studio reference.
**Architecture:** Refine the existing React/Tauri views and shared Studio CSS. Reuse current settings, supervisor state, clip metadata and editor controls.
**Tech Stack:** React 19, TypeScript, CSS, Tauri 2, Rust.
**Spec:** ../specs/2026-10-26-studio-reference-design.md

## Global Constraints
- No new match-data backend or command palette; no invented metadata.
- Preserve all capture, trim, mixer, export, settings and keyboard behavior.
- Work continues in the user's current checkout; keep changes reviewable and do not publish.

## Review Focus
- Minimum 960×620 window must keep navigation, trimming and export reachable.
- Long executable and clip names must not push actions outside the viewport.
- Idle, paused and blocked capture must show accurate state.
- Settings navigation must remain available with the library sidebar hidden.
- Per-export size choices must survive unrelated settings saves.

### Task 1: Shared shell and library
- [x] Update src/App.tsx and src/studio.css: move brand/status into a compact titlebar, central existing clip search, remove duplicate sidebar brand; show readable game name and actual capture info, storage footer.
- [x] Inspect library with real clips; verify filters, keyboard selection, inspector and export remain accessible.

### Task 2: Editor
- [x] Update src/App.tsx and src/studio.css: hide library sidebar during editing, flatten player/header/export/timeline into reference layout, add output summary using existing selection duration and size budget; retain audio controls and all export actions.
- [x] Inspect editor at normal/minimum widths and use trim/mixer/export controls.

### Task 3: Settings and empty/error states
- [x] Update src/panels.tsx, src/App.tsx and src/studio.css: standalone section rail with Library return, compact rows and constrained reading width; refine empty library guidance and capture warning using real status.
- [x] Verify section links, settings persistence and return navigation.

### Task 4: Verify
- [x] Run npm test, npm run build, cargo test --locked and cargo clippy --locked.
- [x] Run the Impeccable detector once on changed UI files; inspect visual defects together and fix one batch.
- [x] Review the resulting diff and report material untested live behavior. No release or push.

## Verification record
- 27 Node tests passed; 44 Rust tests passed, 5 ignored.
- Production frontend build and native debug build passed. Clippy completed with 15 existing warnings.
- Browser checked at 1280x800 and 960x620 using existing local gameplay media. Verified keyboard trim and mixer, saved Ask/Never per-game rules, immediate 50 MB default in both export views, and per-export override survival across an unrelated settings save.
- Compact library hides metadata columns and updates group colspan; title width was verified at 222px with no page overflow at 960px.
- First-run and admin-warning fixtures checked through browser-only ?preview=empty and ?preview=admin.
- Impeccable detector returned no findings. Independent review found no blockers.
- Real privileged-game restart remains untested. No release, push or install was performed for the redesigned build. Existing installed ClipForge was restored; its log confirms the Hunger replay buffer started.
- Ruling: continue in the current checkout on codex/studio-reference because this is continuation work with existing edits; avoid moving the user's active work. UI refinements were verified visually instead of adding source-text or CSS tests.
