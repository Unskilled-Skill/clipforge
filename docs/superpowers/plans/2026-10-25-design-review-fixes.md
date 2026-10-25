# Design Review Fixes Implementation Plan

Goal: resolve the actionable sequential-review findings, prioritizing useful footage size and reachable controls at1280x800 and960x620.
Architecture: keep React/Tauri and existing native CSS/timeline controller. Make the editor an explicit bounded workspace with a large flexible preview, compact export rail, two-row trim controls and an optional internally scrolling audio mixer. Preserve current dirty work; no branch/worktree reset or commits.
Spec: .impeccable/reviews/2026-10-25-design-skills/README.md and linked reports.

## Constraints and review focus
- Default1280x800; minimum960x620; also verify1440x900 and200% text/long-title resilience.
- Player/trim/export must stay reachable with a visible low-disk warning, both with mixer closed and open.
- Preserve waveform/filmstrip, kill markers, trim keyboard semantics, per-track mixing, primary export and secondary share tools.
- No decorative animation on keyboard actions; reduce preference retains informative state without movement/video loops.
- Failure paths must retain edits, announce recovery, and never falsely claim persisted settings.
- Existing onboarding-dot width is a documented deliberate tradeoff, not a new defect to redesign.

## Sequential tasks
- [x] 1 Editor layout/ruler: reproduce undersized preview, introduce bounded responsive rows/rail and optional audio lanes; verify both native sizes, all disclosure states, controls/keyboard.
- [x] 2 Watched-games editing/menu focus: local unnormalized draft saved on blur; restore menu trigger after nondestructive actions without stealing destination focus. Browser regressions.
- [x] 3 Reduced motion/frequent animation: reactive media-query handling for hover video; remove repeat navigation/menu motion and keyboard scale; cover knob/pseudo-element. Verify computed motion and video mounting.
- [x] 4 Settings persistence/recovery: serialized optimistic UI save lifecycle with saved/error/retry state; preserve drafts; setup/backup actionable local alerts. Failure injection and out-of-order save tests.
- [x] 5 Keyboard/semantics/theme: explicit montage moves, headings, skip link, native dark theme, form metadata and modal scroll containment. Keyboard/browser checks.
- [x] 6 Settings hierarchy/tokens/chrome: collapse healthy detail always, grouped task index, simplify nested toggles and consolidate role tokens/CSS overrides. Verify compact/default and focus.
- [x] 7 Pointer/performance: regression-test second-pointer protection; profile frame/layout workload before changing precision geometry; preserve constraints and cleanup.
- [x] 8 Final verification/review: build, JS/Rust tests, browser regressions/failure states, screenshots both native sizes; independent code review and fix any important defects. Save completion evidence.

Ruling: user explicitly requested implementation of all reviewed issues one by one; execute inline without another approval checkpoint. The current dirty workspace contains the app under review, so preserve it in place instead of checking out a clean state that would omit the reviewed work.
