# 06 — Review Animations

Review scope: current UI motion and the pending interface changes, evaluated against review-animations/STANDARDS.md. No source changes. Native desktop use and frequent keyboard interactions take precedence over decorative animation. Findings below use this skill's strict motion bar; Block does not mean the app cannot perform its core task.

| Before | After | Why |
|---|---|---|
| [High] App.css:2085 — Context menu plays cf-rise for120ms, including keyboard open. Browser getAnimations confirmed translateY(7px)→none and opacity0→1. | Open keyboard-invoked/frequent menus immediately; do not add another entrance effect. | The skill disallows motion on keyboard/high-frequency actions. This is an actual running animation, not a dormant declaration. |
| [Medium] App.css:292,1444–1452 — Every Settings mount runs280ms parent rise plus300ms child rises with up to200ms delay. Browser captured all nine animations. | Remove repeat-navigation group entrances; reserve a one-time introductory effect if needed. | Nested movement and stagger can extend settling toward500ms, delaying routine work without conveying state. The library's documented first-paint-only effect is a separate case. |
| [High] App.css:417–421 — Space activation scales Settings to.97 over120ms (browser verified). | Retain pointer press feedback; eliminate transform animation on keyboard activation. | Feedback is useful, but keyboard operations should remain immediate under this skill's frequency rule. |
| [Medium] App.css:2019–2021,2143+ — Reduced motion misses the card-edge scale; browser measured .96→1. App.tsx:2184–2216 still creates looping hover video under reduce. | Reduced variant keeps the still/state/color cues, omits decorative movement and hover playback; gate hover movement to fine pointers. | Movement remains despite the expressed preference. Do not disable intentional main-player playback. |
| [Performance risk] timeline/controller.ts:283 — Per-frame drag writes .mt-range width. | Profile first; if costly, draw the selection fill with transform scaling and preserve border/handle geometry separately. | Width invalidates layout. Direct-DOM/raf coalescing helps, so no dropped-frame claim is made without a trace. |

## Verdict

Feel-breaking/high-frequency criteria: keyboard menu entrance and keyboard press scaling fail this skill's strict requirements. Settings re-entry also repeats an unnecessary authored sequence.

Accessibility: reduced-motion support is substantial (pulse/splash stop; page rise becomes fade; button/card transforms reduce), but the pseudo-element and hover video are uncovered paths.

Performance: trim range width is a profiling candidate. Existing playhead/handles use direct transforms, dim overlays use scaleX, continuous work is raf-coalesced, and progress fill has left-origin transforms. These should be preserved. No transition:all, scale(0) entrance or Framer Motion dependency was found.

Documented tradeoff: App.css:1797–1800 intentionally animates the five tiny onboarding dots' width so neighbors move. Strict GPU-only rules flag that layout choice, but it is rare and explicitly justified. It is not presented as a measured performance incident or a higher priority than repeated keyboard motion.

Timing/cohesion: existing120–250ms transitions and strong --ease-out token are generally appropriate. Constant status/progress loops are not assessed as if they were one-shot UI entrance durations. No request to add springs, clip-path decoration or inertia to precision trimming.

Decision: **Block under the motion skill's criteria**, for verified animation on keyboard actions and incomplete reduced-motion coverage. No implementation performed.
