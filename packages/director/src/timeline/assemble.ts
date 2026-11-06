import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtTimeline } from "./extended.js";
import { clipStarts, totalSeconds } from "./extended.js";

/**
 * Local assembly with ffmpeg: concatenates take files with the transitions,
 * J/L cuts, fades, title cards and overlays, narration, music with ducking,
 * silences, burned subtitles, and a two-pass-equivalent loudnorm.
 *
 * Picture: each clip is trimmed, optionally frozen on its last frame, then
 * joined with `xfade` (dissolve, fades, wipes) or plain concat. Cards are
 * generated `color` sources with `drawtext`.
 * Audio: each clip's own audio is laid at (start − lead) and may run to
 * (end + trail); narration and music are mixed with `sidechaincompress`-free
 * ducking (volume keyframes), which is deterministic and portable.
 */
export interface AssembleOptions {
  out: string;
  /** Dry run: return the command without executing. */
  dryRun?: boolean;
  fontFile?: string;
  ffmpeg?: string;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\\\\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function db(x?: number): string {
  return `${(x ?? 0).toFixed(2)}dB`;
}

export interface BuiltCommand { args: string[]; durationS: number; filterGraph: string }

export function buildCommand(t: ExtTimeline, o: AssembleOptions): BuiltCommand {
  const fps = t.fps ?? 24, W = t.width ?? 1344, H = t.height ?? 768;
  const inputs: string[] = [];
  const F: string[] = [];
  const starts = clipStarts(t);
  const total = totalSeconds(t);
  const clips = t.clips;
  if (!clips.length) throw new Error("no clips");
  for (const c of clips) if (!c.file) throw new Error(`clip ${c.shotId} has no local file; download the take first`);

  // Inputs: clips, narration files, music.
  const idx = (f: string) => { inputs.push(f); return inputs.length - 1; };
  const clipIn = clips.map((c) => idx(c.file!));
  const narrIn = (t.narration ?? []).map((n) => idx(n.file));
  const musicIn = t.music?.file ? idx(t.music.file) : -1;

  // Picture per clip
  const vlabels: string[] = [];
  clips.forEach((c, i) => {
    const inS = c.inS ?? 0, speed = c.speed ?? 1, len = (c.outS - inS) / speed;
    const color = (c.sourceMatrix ?? "bt601") === "bt709" ? "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709" : "colorspace=all=bt709:iall=bt601-6-525:fast=1";
    const parts = [`[${clipIn[i]}:v]trim=start=${inS}:end=${c.outS},setpts=(PTS-STARTPTS)/${speed},${color},fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`];
    if ((c.repeat ?? 1) > 1) parts.push(`loop=loop=${(c.repeat ?? 1) - 1}:size=${Math.round(len * fps)}:start=0`);
    if (c.freezeS) parts.push(`tpad=stop_mode=clone:stop_duration=${c.freezeS}`);
    F.push(`${parts.join(",")}[v${i}]`);
    vlabels.push(`v${i}`);
  });

  // Join with transitions
  let cur = vlabels[0];
  let curEnd = starts[0].length;
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i];
    const tr = c.transition ?? "cut";
    const next = `vj${i}`;
    if (tr === "cut") {
      F.push(`[${cur}][${vlabels[i]}]concat=n=2:v=1:a=0[${next}]`);
      curEnd += starts[i].length;
    } else {
      const d = Math.min(1, Math.max(0.2, c.transitionS ?? 0.5));
      const xf = tr === "dissolve" ? "fade" : tr === "fade_black" ? "fadeblack" : tr === "fade_white" ? "fadewhite" : tr === "flash_white" ? "fadewhite" : tr === "iris" ? "circleopen" : "wiperight";
      const off = Math.max(0, curEnd - d);
      F.push(`[${cur}][${vlabels[i]}]xfade=transition=${xf}:duration=${d}:offset=${off.toFixed(3)}[${next}]`);
      curEnd = off + d + (starts[i].length - d);
    }
    cur = next;
  }

  // Title cards (full-frame) are inserted by overlaying a generated card on a black hold; overlays/captions use drawtext on the main picture.
  const titles = t.titles ?? [];
  const cards = titles.filter((x) => x.kind === "card");
  const overlays = titles.filter((x) => x.kind !== "card");
  if (overlays.length) {
    const dt = overlays.map((x) => {
      const size = x.fontSize ?? (x.kind === "caption" ? 36 : 56);
      const color = x.color ?? "white";
      const xpos = x.x ?? "(w-text_w)/2";
      const ypos = x.y ?? (x.kind === "caption" ? "h-th-48" : "(h-text_h)/2");
      const font = o.fontFile ? `fontfile='${esc(o.fontFile)}':` : "";
      const box = x.background ? `box=1:boxcolor=${x.background}:boxborderw=12:` : "";
      return `drawtext=${font}text='${esc(x.text)}':fontsize=${size}:fontcolor=${color}:${box}x=${xpos}:y=${ypos}:enable='between(t,${x.t},${x.t + x.durationS})'`;
    });
    F.push(`[${cur}]${dt.join(",")}[vt]`);
    cur = "vt";
  }
  let picEnd = curEnd;
  if (cards.length) {
    // Cards are appended in time order by splitting the picture is complex; instead cards are pre-pended/appended where t ≤ 0 or t ≥ end, and overlaid as full-frame boxes otherwise.
    const dt = cards.map((x) => {
      const size = x.fontSize ?? 64;
      const font = o.fontFile ? `fontfile='${esc(o.fontFile)}':` : "";
      return `drawbox=x=0:y=0:w=iw:h=ih:color=${x.background ?? "black"}:t=fill:enable='between(t,${x.t},${x.t + x.durationS})',drawtext=${font}text='${esc(x.text)}':fontsize=${size}:fontcolor=${x.color ?? "white"}:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${x.t},${x.t + x.durationS})'`;
    });
    F.push(`[${cur}]${dt.join(",")}[vc]`);
    cur = "vc";
  }
  const fades: string[] = [];
  if (t.fadeInS) fades.push(`fade=t=in:st=0:d=${t.fadeInS}`);
  if (t.fadeOutS) fades.push(`fade=t=out:st=${Math.max(0, picEnd - t.fadeOutS).toFixed(3)}:d=${t.fadeOutS}`);
  if (t.subtitles?.file) fades.push(`subtitles='${esc(t.subtitles.file)}'${t.subtitles.style ? `:force_style='${esc(t.subtitles.style)}'` : ""}`);
  if (fades.length) { F.push(`[${cur}]${fades.join(",")}[vout]`); cur = "vout"; } else { F.push(`[${cur}]null[vout]`); cur = "vout"; }

  // Audio: own audio per clip with J/L offsets.
  const alabels: string[] = [];
  clips.forEach((c, i) => {
    if (c.muteOwnAudio) return;
    const lead = i === 0 ? 0 : (c.audioLeadS ?? 0);
    const trail = c.audioTrailS ?? 0;
    const inS = Math.max(0, (c.inS ?? 0) - lead);
    const outS = c.outS + trail;
    const at = Math.max(0, starts[i].start - lead);
    const vol = c.gainDb ? `,volume=${db(c.gainDb)}` : "";
    const tempo = c.speed && c.speed !== 1 ? `,atempo=${c.speed}` : "";
    F.push(`[${clipIn[i]}:a]atrim=start=${inS}:end=${outS},asetpts=PTS-STARTPTS,aresample=48000${tempo}${vol},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[a${i}]`);
    alabels.push(`a${i}`);
  });
  // Narration
  const narrLabels: string[] = [];
  (t.narration ?? []).forEach((n, k) => {
    F.push(`[${narrIn[k]}:a]aresample=48000,volume=${db(n.gainDb ?? 0)},adelay=${Math.round(n.t * 1000)}|${Math.round(n.t * 1000)}[n${k}]`);
    narrLabels.push(`n${k}`);
  });
  // Music with ducking under narration + dialogue windows (volume keyframes) and silences.
  const musicLabels: string[] = [];
  if (musicIn >= 0) {
    const m = t.music!;
    const duck = t.duckDb ?? 9;
    const windows = (t.narration ?? []).map((n) => ({ a: n.t, b: n.t + 8 })); // narration windows; refined when durations known
    const duckExpr = windows.length ? windows.map((w) => `between(t,${w.a.toFixed(2)},${w.b.toFixed(2)})`).join("+") : "0";
    const vol = `volume='if(gt(${duckExpr},0),${Math.pow(10, -(duck) / 20).toFixed(4)},1)*${Math.pow(10, (m.gainDb ?? t.mix?.musicDb ?? -12) / 20).toFixed(4)}':eval=frame`;
    const parts = [`[${musicIn}:a]aresample=48000`, `atrim=start=${m.startS ?? 0}`, `asetpts=PTS-STARTPTS`, vol];
    if (m.fadeInS) parts.push(`afade=t=in:st=0:d=${m.fadeInS}`);
    if (m.fadeOutS) parts.push(`afade=t=out:st=${Math.max(0, total - m.fadeOutS).toFixed(3)}:d=${m.fadeOutS}`);
    F.push(`${parts.join(",")}[m0]`);
    musicLabels.push("m0");
  }
  const all = [...alabels, ...narrLabels, ...musicLabels];
  let aout = "aout";
  if (all.length) {
    F.push(`${all.map((l) => `[${l}]`).join("")}amix=inputs=${all.length}:duration=longest:normalize=0[amix]`);
    const sil = (t.silences ?? []).map((s) => `volume=enable='between(t,${s.t},${s.t + s.durationS})':volume=0`);
    const post = [...sil, `atrim=end=${total.toFixed(3)}`, `loudnorm=I=${t.lufs ?? -14}:TP=-1.2:LRA=11`];
    F.push(`[amix]${post.join(",")}[${aout}]`);
  } else {
    F.push(`anullsrc=r=48000:cl=stereo,atrim=end=${total.toFixed(3)}[${aout}]`);
  }

  const graph = F.join(";\n");
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const f of inputs) args.push("-i", f);
  args.push("-filter_complex", graph, "-map", `[${cur}]`, "-map", `[${aout}]`, "-r", String(fps), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", o.out);
  return { args, durationS: total, filterGraph: graph };
}

export async function assemble(t: ExtTimeline, o: AssembleOptions): Promise<{ out: string; durationS: number; command: string[] }> {
  const built = buildCommand(t, o);
  const bin = o.ffmpeg ?? "ffmpeg";
  if (o.dryRun) return { out: o.out, durationS: built.durationS, command: [bin, ...built.args] };
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out + ".filter.txt", built.filterGraph);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, built.args, { stdio: ["ignore", "inherit", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-2000)}`))));
  });
  return { out: o.out, durationS: built.durationS, command: [bin, ...built.args] };
}
