// Ruler and filmstrip: each subscribes to the controller's view (zoom,
// scroll, size) and redraws on its own, so panning never re-renders the
// editor. Both only draw what's on screen.

import { useEffect, useRef, useState } from "react";
import type { TimelineController, TimelineView } from "./controller";
import { fmtTime, groupMarkers, rulerTicks } from "./math";

function useView(ctl: TimelineController | null): TimelineView | null {
  const [view, setView] = useState<TimelineView | null>(null);
  useEffect(() => {
    if (!ctl) return;
    let raf = 0;
    let latest: TimelineView | null = null;
    const unsub = ctl.subscribe((v) => {
      latest = v;
      // Scroll events can outpace frames; render at most once per frame.
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), setView(latest)));
    });
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, [ctl]);
  return view;
}

export function Ruler({ ctl }: { ctl: TimelineController | null }) {
  const view = useView(ctl);
  const ticks = view
    ? rulerTicks(view.duration, view.width, view.scrollLeft - 60, view.scrollLeft + view.viewport + 60)
    : [];
  return (
    <div className="mt-ruler">
      {ticks.map((t) => (
        <span key={t.x} className={`mt-tick ${t.major ? "major" : ""}`} style={{ transform: `translateX(${t.x}px)` }}>
          {t.label && <span className="mt-tick-label">{t.label}</span>}
        </span>
      ))}
    </div>
  );
}

/** Frame count encoded in the reel's filename (`name.reel24.jpg`); the
 * older `.strip.jpg` reels hold 10. */
function reelFrames(src: string): number {
  return Number(src.match(/\.reel(\d+)\.jpg/)?.[1] ?? 10);
}

/**
 * Filmstrip on a canvas the size of the visible lane (sharp at any DPI,
 * never wider than the screen). Tiles keep the video's aspect ratio and
 * stay put while panning; each shows the reel frame nearest its time, so
 * zooming in repeats frames instead of stretching them.
 */
export function Filmstrip({
  ctl,
  reel,
  poster,
}: {
  ctl: TimelineController | null;
  reel: string | null;
  poster: string | null;
}) {
  const view = useView(ctl);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<{ el: HTMLImageElement; frames: number } | null>(null);

  useEffect(() => {
    const src = reel ?? poster;
    if (!src) return;
    let alive = true;
    const el = new Image();
    el.onload = () => {
      // A late poster never replaces a loaded reel.
      if (alive) setImg((prev) => (prev && prev.frames > 1 && !reel ? prev : { el, frames: reel ? reelFrames(reel) : 1 }));
    };
    el.src = src;
    return () => {
      alive = false;
    };
  }, [reel, poster]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !img || view.duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = view.viewport;
    const cssH = canvas.clientHeight;
    const w = Math.min(Math.round(cssW * dpr), 4096);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(w / cssW, 0, 0, h / cssH, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingQuality = "high";

    const { el, frames } = img;
    const srcW = el.naturalWidth / frames;
    const srcH = el.naturalHeight;
    const tileW = Math.max(24, (cssH * srcW) / srcH);
    const first = Math.floor(view.scrollLeft / tileW);
    const last = Math.ceil((view.scrollLeft + cssW) / tileW);
    for (let k = first; k < last; k++) {
      const x0 = k * tileW;
      if (x0 >= view.width) break;
      const mid = Math.min(x0 + tileW / 2, view.width) / view.width;
      const frame = Math.min(frames - 1, Math.floor(mid * frames));
      ctx.drawImage(el, frame * srcW, 0, srcW, srcH, x0 - view.scrollLeft, 0, tileW, cssH);
    }
  }, [view, img]);

  return (
    <canvas
      ref={canvasRef}
      className="mt-film"
      style={{ transform: `translateX(${view?.scrollLeft ?? 0}px)`, width: view?.viewport ?? "100%" }}
    />
  );
}

/**
 * Kill markers, grouped so ones that would overlap at this zoom share a
 * pill with their count; they split apart as you zoom in. Clicking jumps to
 * the group's first kill.
 */
export function KillMarkers({
  ctl,
  times,
  icon,
  onJump,
}: {
  ctl: TimelineController | null;
  times: number[];
  icon: React.ReactNode;
  onJump: (t: number) => void;
}) {
  const view = useView(ctl);
  if (!view || view.duration <= 0) return null;
  return (
    <>
      {groupMarkers(times, view.duration, view.width).map((g) => {
        const n = g.times.length;
        const span = n > 1 ? `${fmtTime(g.times[0])}–${fmtTime(g.times[n - 1])}` : fmtTime(g.t);
        return (
          <button
            type="button"
            aria-label={`${n > 1 ? `${n} kills` : "Kill"} at ${span}. Jump to moment`}
            key={g.t}
            className={`kill-marker ${n > 1 ? "group" : ""}`}
            data-timeline-interactive
            style={{ transform: `translateX(${g.x}px)` }}
            title={`${n > 1 ? `${n} kills` : "Kill"} at ${span} — click to jump`}
            onClick={() => onJump(g.t)}
          >
            {n > 1 ? <span className="kill-count-num">{n}</span> : icon}
          </button>
        );
      })}
    </>
  );
}
