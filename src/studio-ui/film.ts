import { effectiveSeconds } from "@director/catalog";

import type { ProjectView, SceneView, ShotView } from "@/studio/orchestrator";
import type { TimelineInput } from "@/studio/schemas";
import type { Take } from "@/studio/types";

/* The film as one line of time. Every surface that lays things out by the
   second (the line under the top bar, the Score, the Screening strip, the
   Cut) reads the same list, so a shot is the same width everywhere. */

export type FilmShot = {
  shot: ShotView;
  scene: SceneView;
  /** "2·3": scene and shot, both from 1 — what the slate says */
  slate: string;
  /** where the shot starts on the board, in seconds */
  startS: number;
  durationS: number;
  firstOfScene: boolean;
  /** how it joins the shot before it: cut, continuous, … */
  linkIn: string;
  /** the take in the cut, if one is picked */
  picked?: Take;
};

export function filmShots(view: ProjectView): FilmShot[] {
  const out: FilmShot[] = [];
  let at = 0;
  view.scenes.forEach((scene, si) => {
    scene.shots.forEach((shot, i) => {
      const durationS = shot.spec.durationS;
      out.push({
        shot, scene, slate: `${si + 1}·${i + 1}`, startS: at, durationS, firstOfScene: i === 0,
        linkIn: shot.spec.link?.type ?? shot.spec.linkToPrev ?? "cut",
        picked: shot.selectedTake ?? shot.takes.find((t) => t.id === shot.selectedTakeId),
      });
      at += durationS;
    });
  });
  return out;
}

export function filmSeconds(shots: FilmShot[]): number {
  return shots.reduce((n, s) => n + s.durationS, 0);
}

/** 0:31, or 0:31.5 when the half second matters */
export function tc(seconds: number, tenths = false): string {
  const total = tenths ? Math.round(Math.max(0, seconds) * 10) / 10 : Math.round(Math.max(0, seconds));
  const m = Math.floor(total / 60);
  const rest = total - m * 60;
  const whole = Math.floor(rest);
  const tenth = Math.round((rest - whole) * 10);
  return `${m}:${String(whole).padStart(2, "0")}${tenths && tenth ? `.${tenth}` : ""}`;
}

/** The picture that stands for a take: its first thumbnail, else its last frame. */
export function takePicture(take: Take | undefined): string | undefined {
  return take?.thumbUrls[0] ?? take?.lastFrameUrl;
}

/** The picture that stands for a shot: the picked take, else the newest finished take, else its hero frame. */
export function shotPicture(shot: ShotView): string | undefined {
  const picked = shot.selectedTake ?? shot.takes.find((t) => t.id === shot.selectedTakeId);
  const done = shot.takes.find((t) => t.status === "completed");
  return takePicture(picked) ?? takePicture(done) ?? shot.hero?.url;
}

/** What a take's status is called on a pip: the take number, NG for a failure. */
export type PipState = "circled" | "done" | "ng" | "canceled" | "rolling";
export function pipState(take: Take, pickedId: string | undefined): PipState {
  if (take.status === "queued" || take.status === "running") return "rolling";
  if (take.status === "failed" || take.status === "timeout") return "ng";
  if (take.status === "canceled") return "canceled";
  return take.id === pickedId ? "circled" : "done";
}

/** Oldest first, as a camera report lists them (the view carries them newest first). */
export function takesInOrder(shot: ShotView): Take[] {
  return [...shot.takes].sort((a, b) => a.n - b.n);
}

/** What a shot of this length really renders: H3's frame grid (17k+5 at 24 fps). */
export function rendersSeconds(durationS: number): number {
  return effectiveSeconds(durationS);
}

export function shotSpend(shot: ShotView): number {
  return shot.takes.reduce((n, t) => n + (t.costUsd ?? 0), 0);
}

/** A cut after this shot: the next one does not carry on from it. */
export function cutAfter(shots: FilmShot[], i: number): boolean {
  const next = shots[i + 1];
  return !next || next.linkIn !== "continuous";
}

type Clip = TimelineInput["clips"][number];

/** How long a clip runs on the film: its trim, retimed, repeated, plus a held last frame. */
export function clipSeconds(c: Clip): number {
  return (Math.max(0, c.outS - c.inS) / (c.speed || 1)) * (c.repeat || 1) + (c.freezeS ?? 0);
}

/** A continuous join that jumps: the cut leaves the anchor before its take's last frame,
    which is the frame the next shot starts on (orchestrator.checkSeams, seam.trim). */
export type SeamTrim = { clipIndex: number; anchorSlate: string; slate: string; atS: number; cutAtS: number; takeEndS: number; gapS: number };

export function seamTrims(shots: FilmShot[], timeline: TimelineInput): SeamTrim[] {
  const out: SeamTrim[] = [];
  shots.forEach((s, k) => {
    if (s.linkIn !== "continuous") return;
    const link = s.shot.spec.link;
    const anchor = link?.anchorShotId ? shots.find((x) => x.shot.id === link.anchorShotId) : shots[k + (link?.anchor ?? -1)];
    if (!anchor) return;
    const pick = anchor.picked ?? anchor.shot.takes.find((t) => t.status === "completed");
    const clipIndex = timeline.clips.findIndex((c) => c.shotId === anchor.shot.id);
    const clip = timeline.clips[clipIndex];
    if (!pick || !clip) return;
    const takeEndS = pick.outputSeconds ?? anchor.durationS;
    const gapS = takeEndS - clip.outS;
    if (gapS <= 0.15) return;
    const atS = timeline.clips.slice(0, clipIndex + 1).reduce((n, c) => n + clipSeconds(c), 0);
    out.push({ clipIndex, anchorSlate: anchor.slate, slate: s.slate, atS, cutAtS: clip.outS, takeEndS, gapS });
  });
  return out;
}
