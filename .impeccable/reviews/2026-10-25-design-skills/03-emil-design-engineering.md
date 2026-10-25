# 03 — Emil Design Engineering

Intent: a fast desktop gameplay editor whose controls behave predictably under keyboard, pointer, and repeated use. Current source and fresh browser inspection; source unchanged.

| Before | After | Why |
|---|---|---|
| [P2] App.tsx:1361–1374 restores popup focus only for Escape. Activating Copy file closes the menu and document.activeElement becomes BODY (browser verified). | Return focus to the surviving menu trigger after actions; for navigation focus the destination. | Keyboard users lose their place after a successful, routine action. |
| [P2] App.css:421 scales every active button, including keyboard activation. Holding Space on Settings produced matrix(0.97,0,0,0.97,0,0). | Keep pointer press feedback but suppress transform animation for keyboard activation. | Skill frequency rules call for immediate keyboard actions, not animated ones. Pointer feedback itself is appropriate. |
| [P2] App.css:2017–2021 animates .card::before scaleY on hover; reduced-motion rules at2143+ cover the card but not its pseudo-element. Under reduce, measured edge transform changed matrix(1,0,0,.96,0,0)→none. | Keep the state/color cue, remove pseudo-element movement under reduced motion and gate hover movement to fine pointers. | The component is only partially honoring the user's motion preference. |
| [P2] timeline/controller.ts:351–358 accepts a second pointerdown while a gesture is active. Source-only; not tested on physical multi-touch hardware. | Ignore additional pointer IDs until the captured interaction finishes; retain current pointer capture/cancel cleanup. | A second contact can replace pointerId and disrupt precision trimming. |
| [P2] App.tsx:1413–1420 saveSettings rejects without local error/status handling, while many panels callbacks ignore its returned promise. Source-only failure-path observation. | Shared save lifecycle: saving/saved/error feedback, a retry and preserved draft. | A user should know whether a setting was accepted and persisted. |

Verdict: core interaction architecture is strong, but the final details are inconsistent. The direct-DOM timeline, pointer capture, raf coalescing, explicit modal focus guards, and overlap prevention are sensible. Toast entry uses CSS transitions with @starting-style rather than restarting keyframes, and reduced-motion preserves opacity feedback. Native media controls are included in modal traversal.

No recommendation to add a motion library, springs to precision scrubbing, a hold-to-delete gesture, or decorative animation. Those are tools from the skill, not requirements for this desktop task. Do not add momentum to frame-accurate trimming.

Evidence: browser1280x800, isolated design-suite session. Popup Copy action→BODY; Space keydown press matrix; emulated reduce pseudo-element transform. No physical touch or full screen-reader session. Current .onboard-dot width animation is a documented rare-use choice and is not presented as a new performance incident in this pass.
