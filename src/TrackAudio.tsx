// Plays chosen audio tracks of a recording alongside its video: one hidden
// <audio> per track, each soloed to its stream (WebView2 plays only one of a
// video's own tracks at a time), kept in step with the video. Once a track
// is soloed the video's own sound is switched off, so nothing plays twice.
// Without the audio-track API nothing is soloed and the video plays its
// default track as before.

import { useEffect, useRef, type RefObject } from "react";
import { convertFileSrc } from "./tauri-shim";

type TrackList = { length: number; [i: number]: { enabled: boolean } };
const tracksOf = (el: HTMLMediaElement | null) => (el as unknown as { audioTracks?: TrackList } | null)?.audioTracks;

export function TrackAudio({ video, path, tracks, keep, onReady }: {
  video: RefObject<HTMLVideoElement | null>;
  path: string;
  tracks: number;
  keep: Set<number>;
  /** Called once the first track is soloed: the toggles now work. */
  onReady: () => void;
}) {
  const els = useRef<Record<number, HTMLAudioElement | null>>({});
  const soloed = useRef(new Set<number>());

  function applyVolumes() {
    for (const [key, el] of Object.entries(els.current)) {
      if (el) el.volume = soloed.current.has(Number(key)) && keep.has(Number(key)) ? 1 : 0;
    }
  }
  useEffect(applyVolumes);

  function solo(el: HTMLAudioElement, track: number) {
    const list = tracksOf(el);
    if (!list || list.length <= track) return;
    for (let k = 0; k < list.length; k++) list[k].enabled = k === track;
    soloed.current.add(track);
    const own = tracksOf(video.current);
    if (own) for (let k = 0; k < own.length; k++) own[k].enabled = false;
    else if (video.current) video.current.muted = true;
    applyVolumes();
    const v = video.current;
    if (v && !v.paused) {
      el.currentTime = v.currentTime;
      void el.play().catch(() => {});
    }
    onReady();
  }

  // Follow the video: play, pause, seek, speed; nudge back any drift.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const all = () => Object.values(els.current).filter((el): el is HTMLAudioElement => !!el);
    const align = (force: boolean) => {
      for (const el of all()) if (force || Math.abs(el.currentTime - v.currentTime) > 0.2) el.currentTime = v.currentTime;
    };
    const play = () => { align(true); for (const el of all()) void el.play().catch(() => {}); };
    const pause = () => { for (const el of all()) el.pause(); align(true); };
    const seeked = () => align(true);
    const rate = () => { for (const el of all()) el.playbackRate = v.playbackRate; };
    v.addEventListener("play", play);
    v.addEventListener("pause", pause);
    v.addEventListener("seeked", seeked);
    v.addEventListener("ratechange", rate);
    const drift = setInterval(() => { if (!v.paused) align(false); }, 500);
    if (!v.paused) play();
    return () => {
      v.removeEventListener("play", play);
      v.removeEventListener("pause", pause);
      v.removeEventListener("seeked", seeked);
      v.removeEventListener("ratechange", rate);
      clearInterval(drift);
      for (const el of all()) el.pause();
    };
  }, [video, path]);

  return (
    <>
      {Array.from({ length: tracks }, (_, i) => (
        <audio
          key={`${path}#${i}`}
          ref={(el) => { els.current[i] = el; }}
          src={convertFileSrc(path)}
          preload="auto"
          onLoadedMetadata={(e) => solo(e.currentTarget, i)}
        />
      ))}
    </>
  );
}
