# 07 — Improve Animations: codebase audit

Date:25October2026. Scope: full interactive motion surface, read-only standard audit. Current dirty workspace reviewed, not only HEAD. User requested sequential reviews, not implementation; this stops after vetted findings/roadmap. No source, dependency, build, format or commit operations occurred in this pass. This artifact lives under plans/ as required by the skill. No execution plans are approved or implied.

## Recon

Stack: React19, TypeScript, Vite7, Tauri Windows shell. Motion is native CSS in src/App.css and imperative timeline drawing in src/timeline/controller.ts plus canvas/React view subscriptions in parts.tsx. No Framer Motion/Motion/GSAP/spring package is installed or needed for this audit.

Existing conventions: --ease-out:cubic-bezier(0.23,1,0.32,1); --ease-in-out:cubic-bezier(0.77,0,0.175,1). Typical transitions120–300ms. Toast/selection-bar entry uses transitions with @starting-style. Page/context entrances use cf-rise. Frame loop only continues during play/drag/pending seeks, has raf coalescing, and cleans listeners/ResizeObserver/timers in destroy().

Personality/frequency: crisp desktop capture/editor. Scrubbing, frame stepping, library browsing and keyboard actions are frequent. Menus are frequent/occasional, Settings navigation occasional but repeated; onboarding is rare. Keep precision editing direct and deterministic; drawer inertia/elastic overshoot are inappropriate analogies.

The motion surface is small (one global stylesheet, one timeline controller, one parts module), so it was surveyed inline rather than fanning out more agents during this sequential skill pass. Earlier skill reports are evidence to verify, not instructions to repeat unchecked.

## Vetted findings

Severity here is the animation skill's scale, not a product-release severity score.

| ID | Severity | Category | Location | Finding | Fix summary |
|---|---|---|---|---|---|
| M01 | HIGH | Purpose/frequency | App.css:2085; App.tsx:2155 | Keyboard-opened context menu plays120ms cf-rise; browser animation inventory verified translateY7px entrance. | Delete keyboard/frequent entrance motion; preserve focus management. |
| M02 | HIGH | Purpose/frequency | App.css:417–421 | Keyboard Space activation runs.97 press scaling; browser measured transform matrix. | Keep pointer feedback; suppress keyboard movement. |
| M03 | MEDIUM | Accessibility | App.css:2019–2021,1541–1554,2143+; App.tsx:2184–2216 | Reduced variant misses pseudo-element scale and switch-knob travel; hover video still autoplays/loops under reduce. Edge/video were browser verified; switch gap is source-only. | Cover state/decorative paths consistently; retain color/opacity/state feedback. Do not disable user-requested main playback. |
| M04 | MEDIUM | Easing/duration/cohesion | App.css:292,1444–1452 | Repeat Settings mount runs280ms parent plus300ms children with up to200ms stagger. Browser captured9 animations. | Remove repeat navigation choreography; do not layer new effects on it. |
| M05 | MEDIUM, profile first | Performance | timeline/controller.ts:257,283,307–319 | Selection width is written during raf-driven drag; geometry reads and writes deserve a trace. No dropped frames measured. | Profile large/zoomed timelines under decode load before changing the draw model. Preserve exact range borders/handles if scaling fill. |
| M06 | LOW | Cohesion/tokens | App.css:417,542,1305,1444,1725,2413 | Motion durations are distributed among many component rules; strong easing tokens exist but are not used for every entrance. | Consolidate purposeful roles after deleting unnecessary motion; don't flatten everything to one duration. |
| M07 | MEDIUM, hardware verification | Gesture continuity | timeline/controller.ts:351–358 | Active interaction can be replaced by a second pointerdown; guard is absent. | Ignore additional contacts until finish/cancel; retain capture, raf and precision clamping. |

## Eight-category conclusions

1. Purpose/frequency: M01/M02 highest leverage; no animation should delay a keyboard tool.
2. Easing/duration: strong token exists; M04 nested replay is a larger problem than inventing a better curve.
3. Physicality/origin: no scale(0) found. Menus currently translate/fade rather than scale, so a missing scale-origin alone is not a valid finding. Precision range clamping is purposeful, not a missing bounce effect.
4. Interruptibility: toggles/toasts use interruptible transitions; preserve them. Rapid context remount restarts keyframes, another reason to remove M01 rather than convert it into a spring.
5. Performance: handles/playhead/dims/progress correctly favor transforms; M05 is a profiling candidate, not proof of frame drops. No transition:all or parent CSS-variable drag storm was found.
6. Accessibility: M03. Current reduction already disables pulse/splash and removes page-rise displacement. It needs component coverage, not a global removal of every useful feedback transition.
7. Cohesion/tokens: M04/M06. Keep the app's crisp interaction character and distinguish rare setup from frequent work.
8. Missed opportunities: settings persistence needs an explicit saved/error status before it needs animation. An optional brief opacity cue for that status would be system feedback, not decoration. No second additive animation is justified by this evidence; existing toast/progress already marks export success. This deliberately avoids padding the roadmap with speculative delight.

## Settled tradeoff respected

App.css:1797–1800 documents why the rare five-dot onboarding progress animates width: neighbors should move. In accordance with this audit skill, this is recorded as an intentional tradeoff, not re-litigated as a new performance finding. Continuous status loops are not failed merely for lasting longer than a one-shot UI duration budget.

## Recommended order (not implementation authorization)

1. M03 — complete reduced-motion coverage, checking pseudo-elements, knob state and hover previews.
2. M01/M02 — instant keyboard actions, with pointer feedback preserved.
3. M04 — remove repeat Settings choreography; verify immediate focus/interaction.
4. M07 — second-pointer guard, verified on a real Windows hybrid device or controlled pointer test.
5. M05 — profile before optimizing; keep a baseline trace and verify no precision/geometry regression.
6. M06 — token consolidation only after the actual motion inventory has been simplified.

When selected for implementation, use the repository's exact easing token above. Standard skill budgets: button press100–160ms, small popover125–200ms, dropdown150–250ms; ordinary UI under300ms, with instant keyboard paths. Those budgets are not a command to add motion where none belongs. Separate self-contained implementation plans should be written only after the user selects findings.

Verification expectations: repeat keyboard menu and Space-press checks; emulate reduce and inspect computed styles/video mounting; inspect short entry effects frame by frame; test rapid open/close/reversal; profile decode+drag before claiming performance improvements; physical hybrid input for M07. No physical-touch, NVDA or GPU trace was performed in this audit.
