import type { Style } from "../styles/schema.js";
import type { Look, Shotlist, Warning } from "../types.js";
import type { Cinematography } from "../catalog.js";
import { CAMERA_MOVES, type CameraMove } from "../catalog.js";
import { flatShots } from "../types.js";

export interface LookOverrides {
  aspectRatio?: Look["aspectRatio"];
  /** Extra negatives, e.g. from the brief. */
  negative?: string[];
  /** The speed LoRAs the project uses; the style's own LoRAs are appended. */
  loras?: Look["loras"];
  /** Append a phrase to genre / palette, e.g. the user's brand words. */
  genreSuffix?: string;
  paletteSuffix?: string;
}

/** Style → the `look` object `start_film` / `update_look` take. */
export function compileLook(style: Style, o: LookOverrides = {}): Look {
  const e = style.engine;
  const negative = Array.from(new Set([...e.negative, ...(o.negative ?? [])])).slice(0, 10);
  const loras = [...(o.loras ?? []), ...e.loras];
  return {
    genre: clip(e.look.genre + (o.genreSuffix ? `, ${o.genreSuffix}` : "")),
    palette: clip(e.look.palette + (o.paletteSuffix ? `, ${o.paletteSuffix}` : "")),
    camera: clip(e.look.camera),
    lens: clip(e.look.lens),
    lighting: clip(e.look.lighting),
    aspectRatio: o.aspectRatio ?? e.look.aspectRatio,
    resolution: "768p",
    upscale: false,
    negative,
    loras,
  };
}

function clip(s: string): string {
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}

export interface ApplyOptions {
  /** Append the style's beat suffix to each beat (default true). */
  beatSuffix?: boolean;
  /** Fill `sound.music` with the style default when the shot leaves it empty and wants score. */
  musicForShotsWithScore?: boolean;
}

/**
 * Fill every shot's cinematography with the style defaults (explicit values win),
 * add the beat suffix, default the sound fields, and warn about camera moves and
 * links the style does not use. Returns a new shotlist; the input is not mutated.
 */
export function applyStyle(style: Style, list: Shotlist, opts: ApplyOptions = {}): { shotlist: Shotlist; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const allowedMoves = new Set<CameraMove>(style.camera.grammar.map((g) => g.move));
  const preferredLinks = new Set(style.camera.preferredLinks ?? []);
  const out: Shotlist = { scenes: list.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((sh) => ({ ...sh })) })) };

  for (const { scene, shot, index } of flatShots(out)) {
    const base: Cinematography = { ...style.engine.cinematography };
    const size = shot.cinematography?.size;
    const bySize = size && style.engine.bySize?.[size];
    const merged: Cinematography = { ...base, ...(bySize ?? {}), ...(shot.cinematography ?? {}) };
    // Arrays: explicit shot arrays win whole; otherwise style's.
    if (shot.cinematography?.lighting?.length) merged.lighting = shot.cinematography.lighting;
    if (shot.cinematography?.vfx?.length) merged.vfx = shot.cinematography.vfx;
    if (!merged.angle) merged.angle = "eye";
    if (merged.lighting && merged.lighting.length > 4) merged.lighting = merged.lighting.slice(0, 4);
    if (merged.vfx && merged.vfx.length > 4) merged.vfx = merged.vfx.slice(0, 4);
    shot.cinematography = merged;

    if (opts.beatSuffix !== false && style.engine.beatSuffix) {
      const suffix = style.engine.beatSuffix;
      shot.beats = shot.beats.map((b) => {
        if (b.action.includes(suffix)) return b;
        const joined = `${b.action.trim().replace(/[.。]?$/, ".")} ${suffix}`;
        return { ...b, action: joined.length > 400 ? b.action : joined };
      });
    }

    const sound = { ...(shot.sound ?? {}) };
    if (!sound.ambience) sound.ambience = style.sound.ambience.slice(0, 200);
    if (sound.music === undefined) sound.music = "N/A";
    if (opts.musicForShotsWithScore && (sound.music === "" || sound.music === "score")) sound.music = style.sound.musicDefault.slice(0, 200);
    shot.sound = sound;

    if (!CAMERA_MOVES.includes(shot.camera.move)) {
      warnings.push({ code: "camera.unknown", severity: "error", scene: scene.slug, shot: index, message: `camera.move "${shot.camera.move}" is not a Studio move` });
    } else if (!allowedMoves.has(shot.camera.move)) {
      warnings.push({ code: "camera.offstyle", severity: "warn", scene: scene.slug, shot: index, message: `camera.move "${shot.camera.move}" is outside the ${style.slug} grammar (${[...allowedMoves].join(", ")})` });
    } else if (!shot.camera.note) {
      const row = style.camera.grammar.find((g) => g.move === shot.camera.move && g.note);
      if (row?.note) shot.camera = { ...shot.camera, note: row.note };
    }
    if (shot.link && preferredLinks.size && !preferredLinks.has(shot.link.type) && shot.link.type !== "cut") {
      warnings.push({ code: "link.offstyle", severity: "info", scene: scene.slug, shot: index, message: `link "${shot.link.type}" is not among the ${style.slug} preferred links (${[...preferredLinks].join(", ")})` });
    }
    const d = style.engine.durations;
    const complex = shot.beats.length > 1 || (shot.characters?.length ?? 0) > 0 || (shot.dialogue?.length ?? 0) > 0 || merged.pace === "brisk" || merged.pace === "frantic";
    if (complex && shot.durationS > d.maxAction && shot.link?.type !== "loop") {
      warnings.push({ code: "duration.style", severity: "warn", scene: scene.slug, shot: index, message: `${shot.durationS}s action shot; ${style.slug} wants action shots at ${d.action} s (max ${d.maxAction} s) and holds at ${d.hold} s. Split into ${d.action} s shots chained with continuous.` });
    }
    if (style.motion.stepping === "twos" && !/stepped|on twos|stop-motion|12 fps/i.test(shot.beats.map((b) => b.action).join(" "))) {
      warnings.push({ code: "motion.stepping", severity: "info", scene: scene.slug, shot: index, message: `${style.slug} steps on twos; say "stepped motion" in a beat so H3 renders it` });
    }
  }
  return { shotlist: out, warnings };
}
