"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { ProjectView } from "@/studio/orchestrator";
import type { TimelineInput } from "@/studio/schemas";

import { Button } from "./common";
import { useT } from "./i18n";

/* A rough cut in the browser: the timeline's clips played back to back from
   their R2 files, honouring in/out points and repeats, with hard cuts only.
   Dissolves, music and subtitles are the assembler's job (Export); this is
   for judging order and rhythm without spending a render. */

type Segment = { url: string; inS: number; outS: number; shotId: string; label: string };

export function RoughCut({ timeline, view }: { timeline: TimelineInput; view: ProjectView }) {
  const t = useT();
  const takes = useMemo(() => {
    const map = new Map<string, { url?: string; shotIndex: number; intent: string }>();
    for (const scene of view.scenes) for (const shot of scene.shots) for (const take of shot.takes) map.set(take.id, { url: take.resultUrl, shotIndex: shot.index, intent: shot.spec.intent });
    return map;
  }, [view]);

  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = [];
    for (const clip of timeline.clips) {
      const take = takes.get(clip.takeId);
      if (!take?.url) continue;
      for (let n = 0; n < (clip.repeat ?? 1); n++) {
        out.push({ url: take.url, inS: clip.inS, outS: clip.outS, shotId: clip.shotId, label: `${take.shotIndex + 1}. ${take.intent}${(clip.repeat ?? 1) > 1 ? ` (${n + 1}/${clip.repeat})` : ""}` });
      }
    }
    return out;
  }, [timeline, takes]);

  const video = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = segments.reduce((n, s) => n + Math.max(0, s.outS - s.inS), 0);
  const elapsedBefore = segments.slice(0, index).reduce((n, s) => n + Math.max(0, s.outS - s.inS), 0);
  const [position, setPosition] = useState(0);

  /* Load the current segment and seek to its in point; autoplay while playing. */
  useEffect(() => {
    const el = video.current;
    const seg = segments[index];
    if (!el || !seg) return;
    el.src = seg.url;
    el.currentTime = seg.inS;
    if (playing) void el.play().catch(() => setPlaying(false));
  }, [index, segments, playing]);

  const onTime = () => {
    const el = video.current;
    const seg = segments[index];
    if (!el || !seg) return;
    setPosition(elapsedBefore + Math.max(0, el.currentTime - seg.inS));
    if (el.currentTime >= seg.outS - 0.05) {
      if (index + 1 < segments.length) setIndex(index + 1);
      else {
        el.pause();
        setPlaying(false);
      }
    }
  };

  if (segments.length === 0) return <p className="st-muted">{t("Nothing to preview yet: the timeline needs clips whose takes have finished.")}</p>;
  const seg = segments[index]!;
  return (
    <div className="st-roughcut">
      <video ref={video} className="st-video st-roughcut-video" playsInline onTimeUpdate={onTime} onEnded={() => (index + 1 < segments.length ? setIndex(index + 1) : setPlaying(false))} />
      <div className="st-row st-row--between" style={{ marginTop: 8 }}>
        <div className="st-row">
          <Button size="sm" kind="primary" onClick={() => { if (playing) { video.current?.pause(); setPlaying(false); } else { setPlaying(true); void video.current?.play(); } }}>
            {playing ? t("Pause") : index === 0 && position === 0 ? t("Play rough cut") : t("Play")}
          </Button>
          <Button size="sm" kind="quiet" onClick={() => { setIndex(0); setPosition(0); setPlaying(false); video.current?.pause(); }}>{t("Restart||playback")}</Button>
          <Button size="sm" kind="quiet" disabled={index === 0} onClick={() => setIndex(Math.max(0, index - 1))}>{t("Prev")}</Button>
          <Button size="sm" kind="quiet" disabled={index + 1 >= segments.length} onClick={() => setIndex(index + 1)}>{t("Next")}</Button>
        </div>
        <span className="st-muted st-num">{t("{pos} / {total} s · clip {i}/{n}", { pos: position.toFixed(1), total: total.toFixed(1), i: index + 1, n: segments.length })}</span>
      </div>
      <div className="st-roughcut-strip" aria-hidden>
        {segments.map((s, i) => (
          <button key={`${s.shotId}-${i}`} type="button" className="st-roughcut-seg" data-active={i === index ? "true" : undefined} style={{ flex: Math.max(0.2, s.outS - s.inS) }} title={s.label} onClick={() => setIndex(i)} />
        ))}
      </div>
      <div className="st-muted" style={{ marginTop: 4 }}>{seg.label}</div>
      <p className="st-muted" style={{ marginTop: 6 }}>{t("Hard cuts only; dissolves, music and subtitles appear in the exported file.")}</p>
    </div>
  );
}
