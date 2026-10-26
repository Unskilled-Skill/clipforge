// Timeline controller: owns everything that changes per pointer move or per
// frame (playhead, trim handles, dims, scroll, zoom) and writes styles
// directly. React owns the slow inputs (trim range, markers) and hears about
// a drag once, on release. Same split as Medal's trim bar.

import { clamp, snapTime, toTime, toX } from "./math";

/** Handle width (px), drawn inside the selection's edges. */
export const HANDLE_PX = 12;
/** Extra grab tolerance outside a handle (px). */
const HANDLE_SLOP = 6;
/** Shortest selection a drag can make (s). */
const MIN_TRIM = 0.5;
/** At most one seek per this many ms while dragging; the latest wins. */
const SEEK_GAP_MS = 32;
/** Shortest stretch of clip the deepest zoom shows across the viewport (s). */
const MIN_VISIBLE_S = 3;
/** A pointer that moved less than this (px) between down and up is a click. */
const CLICK_PX = 3;

type Mode = "start" | "end" | "move" | "scrub" | null;

export interface TimelineElements {
  /** Horizontally scrolling viewport. */
  scroller: HTMLElement;
  /** Content inside the scroller, `zoom × 100%` wide. */
  sizer: HTMLElement;
  /** Pointer surface spanning every lane. */
  surface: HTMLElement;
  /** The video lane: dragging inside the selection here moves it. */
  videoLane: HTMLElement;
  playhead: HTMLElement;
  range: HTMLElement;
  startHandle: HTMLElement;
  endHandle: HTMLElement;
  dimLeft: HTMLElement;
  dimRight: HTMLElement;
}

export interface TimelineView {
  /** Content width (px) at the current zoom. */
  width: number;
  scrollLeft: number;
  viewport: number;
  duration: number;
  zoom: number;
  maxZoom: number;
}

export interface TimelineCallbacks {
  /** A drag changed the selection (fires once, on release). */
  onTrimCommit(start: number, end: number, by: "start" | "end" | "move"): void;
  /** Live selection while dragging (cheap readouts only). */
  onTrimLive?(start: number, end: number): void;
  /** The user grabbed the timeline (scrub or handle): stop previews. */
  onInteract?(): void;
  /** Settled zoom level, debounced. */
  onZoom?(zoom: number): void;
}

/** Throttled seeking: one seek in flight, one per SEEK_GAP_MS, latest wins. */
class Seeker {
  private pending: number | null = null;
  private last = -1;
  private lastAt = 0;
  constructor(private video: HTMLVideoElement) {}
  now(t: number) {
    this.pending = null;
    if (Math.abs(this.video.currentTime - t) >= 0.005) this.commit(t);
  }
  queue(t: number) {
    this.pending = t;
    this.flush();
  }
  flush() {
    const t = this.pending;
    if (t == null) return;
    if (Math.abs(t - this.last) < 0.005) {
      this.pending = null;
      return;
    }
    if (this.video.seeking || performance.now() - this.lastAt < SEEK_GAP_MS) return;
    this.pending = null;
    this.commit(t);
  }
  get busy() {
    return this.pending != null;
  }
  /** Where the video is headed: a queued seek, or the one in flight. */
  get target(): number | null {
    return this.pending ?? (this.video.seeking ? this.last : null);
  }
  private commit(t: number) {
    this.lastAt = performance.now();
    this.last = t;
    this.video.currentTime = t;
  }
}

export class TimelineController {
  private duration = 0;
  private start = 0;
  private end = 0;
  private zoom = 1;
  private width = 0;
  private viewport = 0;

  private mode: Mode = null;
  private pointerId: number | null = null;
  private pendingX: number | null = null;
  private downX = 0;
  private wasPlaying = false;
  private grab = 0;
  private orig = { start: 0, end: 0 };
  private snapTargets: number[] = [];
  private latched: number | null = null;

  private raf = 0;
  /** The user scrolled by hand: don't auto-follow the playhead until play. */
  private userScrolled = false;
  private programmaticScroll = false;
  private zoomTimer = 0;
  private markers: number[] = [];
  private listeners = new Set<(v: TimelineView) => void>();
  private ro: ResizeObserver;
  private seeker: Seeker;

  constructor(
    private video: HTMLVideoElement,
    private el: TimelineElements,
    private cb: TimelineCallbacks,
  ) {
    this.seeker = new Seeker(video);
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(el.scroller);
    el.surface.addEventListener("pointerdown", this.onDown);
    el.surface.addEventListener("pointermove", this.onMove);
    el.surface.addEventListener("pointerup", this.onUp);
    el.surface.addEventListener("pointercancel", this.onUp);
    el.surface.addEventListener("dblclick", this.onDoubleClick);
    el.scroller.addEventListener("wheel", this.onWheel, { passive: false });
    el.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    video.addEventListener("play", this.onPlay);
    video.addEventListener("seeked", this.onSeeked);
    video.addEventListener("loadedmetadata", this.onSeeked);
    this.measure();
    this.paintPlayhead(video.currentTime);
    if (!video.paused) this.loop();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.zoomTimer);
    this.ro.disconnect();
    const { surface, scroller } = this.el;
    surface.removeEventListener("pointerdown", this.onDown);
    surface.removeEventListener("pointermove", this.onMove);
    surface.removeEventListener("pointerup", this.onUp);
    surface.removeEventListener("pointercancel", this.onUp);
    surface.removeEventListener("dblclick", this.onDoubleClick);
    scroller.removeEventListener("wheel", this.onWheel);
    scroller.removeEventListener("scroll", this.onScroll);
    this.video.removeEventListener("play", this.onPlay);
    this.video.removeEventListener("seeked", this.onSeeked);
    this.video.removeEventListener("loadedmetadata", this.onSeeked);
    this.listeners.clear();
  }

  // ---- inputs from React --------------------------------------------------

  setDuration(d: number) {
    if (d > 0 && d !== this.duration) {
      this.duration = d;
      this.measure();
    }
  }

  setTrim(start: number, end: number) {
    if (this.mode) return; // a drag owns the selection until release
    this.start = start;
    this.end = end > start ? end : this.duration;
    this.paintTrim();
  }

  /** Kill markers etc.: drags snap to these as well as the playhead. */
  setMarkers(times: number[]) {
    this.markers = times;
  }

  subscribe(fn: (v: TimelineView) => void): () => void {
    this.listeners.add(fn);
    fn(this.view());
    return () => this.listeners.delete(fn);
  }

  get maxZoom() {
    return Math.max(1, this.duration / MIN_VISIBLE_S);
  }

  /** Zoom keeping `atTime` under `atScreenX` (px from the viewport's left);
   * by default the playhead stays where it is, or is centred if off screen. */
  setZoom(z: number, atTime?: number, atScreenX?: number) {
    const zoom = Math.round(clamp(z, 1, this.maxZoom) * 100) / 100;
    if (zoom === this.zoom) return;
    const scroller = this.el.scroller;
    let t = atTime;
    let sx = atScreenX;
    if (t == null) {
      t = this.video.currentTime;
      const px = toX(t, this.duration, this.width) - scroller.scrollLeft;
      sx = px >= 0 && px <= this.viewport ? px : this.viewport / 2;
    }
    this.zoom = zoom;
    this.el.sizer.style.width = `${zoom * 100}%`;
    this.measure();
    this.scrollTo(toX(t, this.duration, this.width) - (sx ?? 0));
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.cb.onZoom?.(this.zoom), 120);
  }

  zoomBy(factor: number) {
    this.setZoom(this.zoom * factor);
  }

  /** Zoom so [a, b] fills ~80% of the view, centred. */
  fitRange(a: number, b: number) {
    if (this.duration <= 0 || b <= a) return;
    const zoom = clamp((this.duration / (b - a)) * 0.8, 1, this.maxZoom);
    this.setZoom(zoom, (a + b) / 2, this.viewport / 2);
    this.userScrolled = true; // keep the fitted view, don't jump to the playhead
  }

  // ---- geometry -----------------------------------------------------------

  private measure() {
    this.viewport = this.el.scroller.clientWidth;
    this.width = this.el.sizer.clientWidth;
    if (!this.duration && Number.isFinite(this.video.duration)) this.duration = this.video.duration;
    this.paintTrim();
    if (!this.mode) this.paintPlayhead(this.video.currentTime);
    this.emit();
  }

  private view(): TimelineView {
    return {
      width: this.width,
      scrollLeft: this.el.scroller.scrollLeft,
      viewport: this.viewport,
      duration: this.duration,
      zoom: this.zoom,
      maxZoom: this.maxZoom,
    };
  }

  private emit() {
    const v = this.view();
    for (const fn of this.listeners) fn(v);
  }

  private x(t: number) {
    return toX(t, this.duration, this.width);
  }

  /** Time under a client X coordinate. */
  private timeAt(clientX: number) {
    const left = this.el.sizer.getBoundingClientRect().left;
    return toTime(clientX - left, this.duration, this.width);
  }

  private scrollTo(left: number) {
    const s = this.el.scroller;
    const target = clamp(left, 0, Math.max(0, this.width - this.viewport));
    if (Math.abs(s.scrollLeft - target) < 0.5) return;
    this.programmaticScroll = true;
    s.scrollLeft = target;
  }

  // ---- painting -----------------------------------------------------------

  private paintTrim() {
    if (this.duration <= 0) return;
    const { range, startHandle, endHandle, dimLeft, dimRight } = this.el;
    const s = this.x(this.start);
    const e = this.x(Math.min(this.end || this.duration, this.duration));
    const W = Math.max(this.width, 1);
    range.style.transform = `translateX(${s}px) scaleX(${Math.max(e - s, 0) / W})`;
    startHandle.style.transform = `translateX(${s}px)`;
    endHandle.style.transform = `translateX(${e - HANDLE_PX}px)`;
    dimLeft.style.transform = `scaleX(${s / W})`;
    dimRight.style.transform = `scaleX(${(W - e) / W})`;
  }

  /** Keyboard stepping. Pauses, moves on from where the previous step was
   * headed (not where the decoder has got to), and seeks latest-wins, so a
   * held arrow key never builds a backlog. With `fps`, steps whole frames
   * and lands mid-frame, so every press shows a new picture. */
  step(amount: number, fps?: number) {
    if (!this.video.paused) this.video.pause();
    const from = this.seeker.target ?? this.video.currentTime;
    const end = this.duration || this.video.duration || 0;
    const t = fps ? (Math.floor(from * fps + 1e-3) + amount + 0.5) / fps : from + amount;
    const to = Math.min(Math.max(0, t), Math.max(0, end - 0.001));
    this.seeker.queue(to);
    this.paintPlayhead(to);
    this.follow(to);
    this.loop();
  }

  private paintPlayhead(t: number) {
    this.el.playhead.style.transform = `translateX(${this.x(t)}px)`;
  }

  /** While playing zoomed in, page the view along with the playhead. */
  private follow(t: number) {
    if (this.userScrolled || this.zoom <= 1) return;
    const x = this.x(t);
    const left = this.el.scroller.scrollLeft;
    if (x < left || x > left + this.viewport - 24) this.scrollTo(x - this.viewport * 0.1);
  }

  // ---- frame loop: runs only while playing or dragging --------------------

  private loop() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = 0;
    if (this.mode && this.pendingX != null) {
      const cx = this.pendingX;
      this.pendingX = null;
      if (this.mode === "scrub") this.scrubTo(this.timeAt(cx));
      else this.drag(cx);
    } else if (!this.mode) {
      const t = this.seeker.target ?? this.video.currentTime;
      this.paintPlayhead(t);
      if (!this.video.paused) this.follow(t);
    }
    this.seeker.flush();
    if (this.mode || !this.video.paused || this.seeker.busy) this.loop();
  };

  private onPlay = () => {
    this.userScrolled = false;
    this.loop();
  };

  private onSeeked = () => {
    if (!this.mode) this.paintPlayhead(this.video.currentTime);
    this.seeker.flush();
  };

  // ---- pointer ------------------------------------------------------------

  private hit(clientX: number, target: Element): Mode {
    const left = this.el.sizer.getBoundingClientRect().left;
    const x = clientX - left;
    const s = this.x(this.start);
    const e = this.x(this.end);
    const onStart = x >= s - HANDLE_SLOP && x <= s + HANDLE_PX;
    const onEnd = x >= e - HANDLE_PX && x <= e + HANDLE_SLOP;
    if (onStart && onEnd) return x - s < e - x ? "start" : "end";
    if (onStart) return "start";
    if (onEnd) return "end";
    const trimmed = this.start > 0.01 || this.end < this.duration - 0.01;
    if (trimmed && x > s && x < e && this.el.videoLane.contains(target)) return "move";
    return "scrub";
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.duration <= 0 || this.pointerId != null) return;
    const target = e.target as Element;
    if (target.closest("[data-timeline-interactive]")) return;
    this.measure();
    this.mode = target.closest("[data-playhead]") ? "scrub" : this.hit(e.clientX, target);
    this.pointerId = e.pointerId;
    this.el.surface.setPointerCapture(e.pointerId);
    this.downX = e.clientX;
    this.wasPlaying = !this.video.paused;
    this.video.pause();
    this.userScrolled = false;
    this.cb.onInteract?.();
    this.el.surface.dataset.dragging = this.mode ?? "";
    if (this.mode === "scrub") {
      this.scrubTo(this.timeAt(e.clientX));
    } else {
      const t = this.timeAt(e.clientX);
      this.orig = { start: this.start, end: this.end };
      this.grab = t - (this.mode === "end" ? this.end : this.start);
      // Snap to where the playhead was and to markers, never to itself.
      this.snapTargets = [this.video.currentTime, ...this.markers];
      this.latched = null;
      if (this.mode !== "move") this.seeker.now(this.mode === "start" ? this.start : this.end);
    }
    this.loop();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId === this.pointerId) {
      this.pendingX = e.clientX; // applied once per frame
      this.loop();
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    if (this.el.surface.hasPointerCapture(e.pointerId)) this.el.surface.releasePointerCapture(e.pointerId);
    this.pointerId = null;
    const mode = this.mode;
    if (this.pendingX != null) {
      if (mode === "scrub") this.scrubTo(this.timeAt(this.pendingX));
      else if (mode) this.drag(this.pendingX);
      this.pendingX = null;
    }
    this.mode = null;
    this.latched = null;
    delete this.el.surface.dataset.dragging;
    delete this.el.surface.dataset.snapped;
    const clicked = Math.abs(e.clientX - this.downX) < CLICK_PX;
    if (mode === "scrub") {
      this.seeker.now(this.timeAt(e.clientX));
      if (this.wasPlaying) this.video.play().catch(() => {});
    } else if (mode === "move" && clicked) {
      // A click inside the selection seeks, like anywhere else.
      this.seeker.now(this.timeAt(e.clientX));
      if (this.wasPlaying) this.video.play().catch(() => {});
    } else if (mode && (this.start !== this.orig.start || this.end !== this.orig.end)) {
      this.cb.onTrimCommit(this.start, this.end, mode as "start" | "end" | "move");
    } else if (mode && this.wasPlaying) {
      this.video.play().catch(() => {});
    }
  };

  private onDoubleClick = (e: MouseEvent) => {
    // Double-clicking a handle resets that side to the clip's edge.
    const mode = this.hit(e.clientX, e.target as Element);
    if (mode !== "start" && mode !== "end") return;
    if (mode === "start") this.start = 0;
    else this.end = this.duration;
    this.paintTrim();
    this.cb.onTrimCommit(this.start, this.end, mode);
  };

  private scrubTo(t: number) {
    this.paintPlayhead(t);
    this.seeker.queue(t);
  }

  private drag(clientX: number) {
    const D = this.duration;
    const pps = this.width / Math.max(D, 0.001);
    const t = this.timeAt(clientX) - this.grab;
    if (this.mode === "move") {
      const len = this.orig.end - this.orig.start;
      this.start = clamp(t, 0, D - len);
      this.end = this.start + len;
    } else if (this.mode === "start") {
      const snapped = snapTime(t, this.snapTargets, this.latched, pps);
      this.latched = snapped.latched;
      this.start = clamp(snapped.t, 0, Math.max(this.end - MIN_TRIM, 0));
      this.seeker.queue(this.start);
      this.paintPlayhead(this.start);
    } else if (this.mode === "end") {
      const snapped = snapTime(t, this.snapTargets, this.latched, pps);
      this.latched = snapped.latched;
      this.end = clamp(snapped.t, Math.min(this.start + MIN_TRIM, D), D);
      this.seeker.queue(this.end);
      this.paintPlayhead(this.end);
    }
    this.el.surface.dataset.snapped = this.latched != null ? "1" : "";
    this.paintTrim();
    this.cb.onTrimLive?.(this.start, this.end);
  }

  // ---- wheel & scroll -----------------------------------------------------

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom anchored under the cursor.
      e.preventDefault();
      const rect = this.el.scroller.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY);
      this.setZoom(this.zoom * factor, this.timeAt(e.clientX), e.clientX - rect.left);
      return;
    }
    if (this.zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // Plain wheel pans the zoomed timeline instead of the page.
      e.preventDefault();
      this.el.scroller.scrollLeft += e.deltaY;
    }
  };

  private onScroll = () => {
    if (this.programmaticScroll) this.programmaticScroll = false;
    else this.userScrolled = true;
    this.emit();
  };
}
