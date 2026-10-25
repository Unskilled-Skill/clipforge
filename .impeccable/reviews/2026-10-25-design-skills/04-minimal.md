# 04 — Minimal

Intent: reduce competing chrome so the saved moment and next useful action lead. Preserve ClipForge's dark gameplay-editor identity, existing Bricolage/Hanken/JetBrains fonts and functional game colors. This is a restraint/consistency review, not a request to apply the skill's example light palette or replace fonts.

## Findings

- [P1, shared with01] App.css:2481,2445 — Whitespace is misplaced: a large blank center coexists with a267x150 footage preview at the default window. Minimalism should remove obstacles, not reduce the artifact users need to judge. Give footage the reclaimed space; compact supporting export/mixer controls instead.
- [P2] App.css:1439,1520 — Settings uses bordered rounded sections containing bordered rounded toggle rows. This adds two levels of container chrome around simple labels and switches. Keep section structure; test replacing inner toggle boxes with consistent aligned rows and spacing. Preserve focus, grouping and hover states.
- [P2, shared with01] panels.tsx:557,650,771 — Nine same-weight destinations and expanded healthy checks give reference information primary visual weight. Keep issue summary and task settings prominent; disclose healthy details and group navigation by tasks.
- [P2, implementation consistency] App.css:1 and repeated component declarations — Source inventory contains102 distinct hexadecimal literals and17 distinct font-size values (9.5–28px), across a cascade with later overrides. This does NOT mean102 colors are simultaneously visible. Semantic text/surface/border/status tokens and a smaller set of type roles would make future consistency fixes safer. Retain actual game brand colors separately; don't impose an arbitrary tiny palette on content.
- [P3] App.css:581,751,2008 and App.tsx library card/day headings — Game identity repeats in tag, title, stripe and session text; clip size repeats at library/day/card levels. Choose which repetition helps recognition and demote the rest. Do not remove file-size access or accessible game names merely to make a screenshot cleaner.

## Foundations and component guidance

Keep semantic roles for surface/base, surface/raised, text/primary, text/secondary, border/control, accent/action, success/warning/danger. Use the incumbent colors that meet contrast instead of introducing a new palette. Consolidate spacing around a4px base with deliberate tight/loose groups. Use a few named text roles rather than replacing all existing px values indiscriminately. Data/time retains tabular monospaced numerals; prose need not become monospace.

Library: imagery/moment first, actions second, metadata third. Editor: footage first, selection/audio second, export confirmation third. Settings: user decisions before healthy diagnostic inventory. Required states remain default, hover, focus-visible, disabled, loading, error, empty and long-content. Native window adaptation must remain explicit at1280x800 and960x620.

Accessibility requirements: secondary text >=4.5:1, visible keyboard focus, content available through200% text zoom, no information conveyed by game color alone. Fewer borders must not reduce control recognizability. Ruler readability is a real issue; changing display fonts is not a prerequisite.

Copy: prefer action labels and one-line help. Existing Export and copy, Find blank recordings and named track controls are good. Keep necessary recovery text available rather than truncating it to meet a word count.

Anti-patterns: whitespace that steals image size; nested decorative containers; blanket removal of useful status; enforcing this skill's sample fonts/light palette on a dark desktop tool; reporting duplicate historical CSS declarations as simultaneously rendered styles.

## QA checklist

- [ ] Default/minimum windows give footage a useful viewing area while controls stay reachable.
- [ ] Removing a container preserves grouping, focus and hit targets.
- [ ] Type-role changes retain4.5:1 contrast and readable ruler labels.
- [ ] Game identity remains recognizable without relying only on colored accents.
- [ ] Empty/error/loading/long-title states survive simplification.
- [ ] Screenshot comparison and keyboard pass show the same task order.

No source changes. Evidence: current source plus fresh suite-a library/settings/editor screenshots; this pass proposes no rebrand.
