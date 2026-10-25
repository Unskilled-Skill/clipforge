# ClipForge — sequential design-skill reviews

25October2026. Reviews performed one skill at a time on the same unchanged app source. The only parallelism was Impeccable's required independent design/evidence assessments inside pass1. No product code was changed, no fixes applied, no dependencies installed and no commits created. Source SHA256 fingerprints matched before/after. Builds/tests were not rerun for this read-only review.

## Review index

| Order | Skill | Result | Report |
|---|---|---|---|
|1|Impeccable|28/40, Good; compact desktop layout remains weak|[Review](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/01-impeccable.md)|
|2|Design Taste Frontend|Not applicable: skill excludes multi-step product UI|[Scope assessment](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/02-design-taste-scope.md)|
|3|Emil Design Engineering|Interaction polish gaps; browser-confirmed focus/motion issues|[Review](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/03-emil-design-engineering.md)|
|4|Minimal|Rebalance space; simplify nested chrome and design roles|[Review](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/04-minimal.md)|
|5|Web Interface Guidelines|Functional editing and accessibility gaps|[Review](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/05-web-interface-guidelines.md)|
|6|Review Animations|Block under the strict motion criteria|[Review](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/06-review-animations.md)|
|7|Improve Animations|Prioritized motion roadmap; no implementation selected|[Audit](D:/DEV/clipforge/plans/design-motion-audit-2026-10-25.md)|

Six substantive reviews plus one explicit scope assessment. A Block in the motion-specific skill is not an assertion that the application is unusable. Numeric scores were not invented for skills without a scoring rubric.

Impeccable history is26→29→28/40. This pass expanded testing to the actual native default1280x800 and minimum960x620; the earlier pass focused on900px height. Different viewport coverage and independent judgment mean the score change is not evidence that a code regression occurred.

## Consolidated findings, duplicates removed

| Priority | Finding | Evidence | Reviews agreeing |
|---|---|---|---|
|P1|Footage receives too little space: five-track preview is about267x150 at default/minimum height; empty center remains|Observed screenshots; App.css:2481,2445|Impeccable, Minimal|
|P1|Minimum960x620 editor separates preview/mixer and crowds trim toolbar; compact desktop layout needed|Observed, scroll still works; App.css:1025,1120,2462|Impeccable, Minimal|
|P2|Timeline ruler9.5px and faint|Source plus visual evidence; App.css:1825–1827|Impeccable, Minimal|
|P2|Watched-games textarea removes newline while typing; Enter cannot add a new row|Browser verified before/after identical; panels.tsx:1149|Web Guidelines|
|P2|Reduced motion misses hover-video loops, card-edge scale, and switch-knob travel|Video/edge observed; knob source-only|Emil, Web Guidelines, both motion reviews|
|P2|Menu Copy action drops keyboard focus to BODY|Browser verified; App.tsx:1361–1374|Emil|
|P2|Keyboard actions animate and repeat Settings entrances add nested choreography|Browser matrices and animation inventory; App.css:421,2085,292,1444+|Emil, both motion reviews|
|P2|Settings persistence and some setup/backup failures lack consistent feedback/recovery|Source-only failure paths; App.tsx:1413; SetupCheck.tsx:32; panels.tsx:406|Impeccable, Emil, Web Guidelines|
|P2|Montage reorder lacks direct keyboard move controls|Source; rebuilding selection order is an inconvenient workaround|Web Guidelines|
|P2|Missing heading structure and dark native-control theme declaration|Source; computed color-scheme:normal verified|Web Guidelines|
|P2, verify hardware|Second pointer can replace active timeline gesture|Source-only; controller.ts:351–358|Emil, Improve Animations|
|P2/P3|Healthy diagnostics and nine peer Settings destinations outweigh task controls|Observed default/minimum screens|Impeccable, Minimal|
|P3|Nested borders and dispersed typography/color literals increase visual/system complexity|Source inventory;102 hex literals/17 font sizes include historical overrides, not simultaneous visible styles|Minimal|
|P3|Storage-warning button wraps poorly at minimum width; no skip-to-main; dialog scroll containment absent|Screenshot/source, see reports|Impeccable, Web Guidelines|
|Profile first|Per-frame selection-width writes may cost layout|Source only; no GPU trace or dropped frames measured|Both motion reviews|

## What to preserve

Game/day/moment-based library identity; one clear Discord export path; real-time filmstrip, kill markers and trim readouts; pointer capture and raf-coalesced timeline drawing; labeled tracks and slider keyboard support; native media focus support; delete confirmation/Undo; skippable onboarding and setup verification; self-hosted fonts and consistent icons.

## Recommended implementation order — not executed

1. Correct the watched-games editing behavior and focus return; close reduced-motion gaps.
2. Recompose the default/minimum editor around useful footage size and a compact reachable timeline; improve ruler readability.
3. Unify settings save/error feedback and compact diagnostic/navigation hierarchy.
4. Add keyboard montage reorder and complete heading/native-theme details.
5. Remove repeated keyboard/navigation motion. Keep pointer feedback and semantic state indication.
6. Consolidate tokens/chrome; profile timeline geometry before changing its rendering model.

## Conflicting advice resolved

- Minimal favors restraint; Emil favors responsive feedback. Preserve feedback while removing repeated/decorative movement.
- Strict motion rules flag layout animation; the whole-codebase audit respects the explicitly documented rare onboarding-dot width tradeoff. It is not a demonstrated performance incident.
- Fine precision editing should remain direct. Do not import gesture inertia, spring bounce, scroll storytelling or marketing hero rules into a trim tool.
- Do not replace the existing dark palette/fonts merely because a skill's example system differs.

## Scope and limitations

Animate is an implementation skill, not another independent review rubric. Sites, visualization, image/document/presentation and Unity skills are not applicable to reviewing this React/Tauri desktop interface. Impeccable subcommands are playbooks within the same skill rather than independent installed review skills.

The Web pass fetched the [current primary guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md). Its web-only URL routing, SSR, phone safe-area and marketing rules were not imposed on the native app.

Browser preview uses fixtures; actual game capture, native filesystem export, uploads, NVDA, physical multi-touch and GPU traces were not exercised. Source-only and browser-confirmed observations are distinguished. Detector-overlay false positives were filtered; no current visible Human overlay is claimed.

Evidence screenshots are under evidence/ and [the browser evidence notes](D:/DEV/clipforge/.impeccable/reviews/2026-10-25-design-skills/evidence/impeccable-browser-evidence.md). Review sessions and temporary detector servers were closed; the shared preview server is stopped after consolidation. Reports and evidence remain intentionally saved.

Questions skipped: the user requested sequential reviews; choosing implementation scope is outside this read-only pass.
