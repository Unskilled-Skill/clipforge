# Finish the Studio reference on existing screens

## Intent
Continue the committed Studio redesign using the user's ClipForge UI Redesign.html as the visual authority. Finish existing screens before adding the reference's new feature set. This pass is for local review; do not publish a release.

## Approach
The user chose to finish existing screens first over implementing all seven boards and their new features. Refine the existing React/Tauri implementation rather than replace its capture, editing or settings logic.

## Scope
- Shared shell: compact title bar, one brand mark, capture status at the right, reference spacing and neutral/teal palette. Search uses existing clip search; no command palette in this pass.
- Library and details: dense divided rows, clear selection, readable game names, consistent preview/facts/actions, and storage information from actual settings and files.
- Editor: give the player more room by removing the library sidebar while editing, flatten the player/export/timeline layout, align export controls and trim/audio controls with the reference. Preserve trim persistence, audio mixing, all export formats and keyboard controls.
- Settings: retain the implemented section navigation and settings; match the compact flat reference and improve hierarchy and spacing.
- Empty library and capture problem: use the reference's practical guidance and amber/teal status treatment, driven by actual setup and supervisor state.

## Constraints
No invented map, round, match result, codec or health values. Keep existing full-session recordings accessible through the existing editor. No new round-results backend, command palette, or fictitious controls. Preserve native window controls, recording and existing settings.

## Verification
TypeScript/production build and Node/Rust tests; inspect the reference and changed app at normal and minimum supported window sizes. Check real clips, navigation, preview, trimming, mixer, export, settings saves and empty/error presentation. Real privileged-game restart still needs a Windows permission prompt and live validation; do not claim it was tested from unit tests alone.

## Existing fixes carried forward
Apply changed Discord defaults immediately; allow Ask/Never per-game rules without elevation; retain the shared admin task when auto rules need it; allow Ask-to-Auto changes for an already running game.
