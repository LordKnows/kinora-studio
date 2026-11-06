import type { LintElement, ScreenPosition, Shot, Shotlist, Warning } from "../types.js";
import { flatShots } from "../types.js";

/*
 * Craft lint: the storyboard discipline the rhythm lint does not cover.
 * Staging in screen terms (who goes where, what moves), wording the video
 * model misreads, and the pictures video models get wrong most often. Most
 * findings are `info`: they ask the director to look, they do not block.
 * Source: Eian Lu's Claude Code + Seedance workflow, adapted to H3.
 */

export interface CraftOptions {
  /** Project elements, so names found in beats can be checked against the shot's lists. */
  elements?: LintElement[];
  /** The film is animated (a style with an animation key): cartoon wording grows faces on clouds. */
  animated?: boolean;
}

/** A picture the video model tends to get wrong, found by its words. */
interface FragilePattern {
  code: string;
  label: string;
  re: RegExp;
  advice: string;
}

/* The fixed weak spots of AI video (crossing people, small things in hands,
   text, mirrors, a light change inside one shot …). Each one raises the
   reroll rate; avoid them when writing the story, not after the take. */
export const FRAGILE_PATTERNS: FragilePattern[] = [
  { code: "crossing", label: "people crossing", re: /\b(cross(es|ing)? paths?|pass(es|ing)? (each other|behind|in front of)|weav(e|es|ing) through)\b|交叉|擦肩|穿过人群/i, advice: "two bodies overlapping in motion; stage them on separate depths or cut between them" },
  { code: "small_object", label: "small object in hand", re: /\b(holds?|holding|picks? up|hands? over|grips?|twirls?|threads?)\b[^.;]{0,30}\b(pen|pencil|key|keys|coin|ring|needle|card|ticket|phone|cup|spoon|chopsticks?|cigarette|match|lighter|letter|envelope)\b|(拿|捏|握|递|夹)(着|起)?[^，。]{0,6}(笔|钥匙|硬币|戒指|针|卡|票|手机|杯|勺|筷子|烟|火柴|信)/i, advice: "hands and small props morph; show the object before and after, or keep it out of the action" },
  { code: "text", label: "readable text", re: /\b(sign|signboard|label|headline|newspaper|letter reads|writes|writing|handwriting|caption|subtitle|logo|text on)\b|招牌|标语|写字|文字|字幕|报纸|信上写/i, advice: "the model cannot spell; add text in the edit (title or overlay) and keep the frame free of writing" },
  { code: "mirror", label: "mirror or reflection", re: /\b(mirror|reflection|reflected|reflects)\b|镜子|倒影|镜中|反射/i, advice: "reflections rarely match the subject; avoid, or make the reflection the only subject" },
  { code: "light_change", label: "light changes inside the shot", re: /\b(lights? (go|goes|went|turn|turns|switch|switches|flicker|flickers)( (on|off|out))?|blackout|power cut|sun (sets|rises)|lightning)\b|灯(灭|亮|关|开|闪)|停电|天黑|天亮|闪电/i, advice: "one shot, one lighting state; cut on the change, or write 'a white flash inside the clouds' and trim it in the edit" },
  { code: "chain", label: "one person, three actions", re: /(\bthen\b[^.;]*\bthen\b)|((然后|接着|随后)[^。]*(然后|接着|随后))/i, advice: "H3 holds one action per 5 s; split the chain across shots" },
  { code: "crowd", label: "too many people", re: /\b(crowd|audience|everyone|everybody|dozens of|a group of|passers-by|bystanders)\b|人群|观众|围观|一群/i, advice: "extras multiply errors; keep two or three readable people, the rest soft in the background" },
  { code: "cartoon", label: "cartoon wording on a non-character", re: /\b(cartoon|cute|kawaii|smiling (sun|moon|cloud|tree|flower))\b|卡通|可爱|拟人/i, advice: "'cartoon cloud' grows eyes and a mouth; describe the material ('fluffy grey cumulus, cotton texture and shadow only') and only how it moves" },
];

const SIMULTANEOUS = /\b(everyone|everybody|all of them|in unison|at the same time|simultaneously|together they)\b|大家|所有人|同时|一起|齐刷刷|不约而同/i;
const NEGATION = /\b(no|not|never|without|don't|doesn't|won't|nothing)\b|不要|没有|不会|别再|不能|禁止/i;
const LOOSE_DIRECTION = /\b(to the (left|right)|towards? the (left|right)|leftwards?|rightwards?|turns? (left|right)|goes (left|right)|walks? (left|right))\b|向左|向右|往左|往右|朝左|朝右/i;
const SCREEN_ANCHORED = /\b(frame|screen) (left|right)\b|\b(left|right) (of|edge of) (the )?(frame|screen)\b|画面(左|右)/i;

const POS_X: Partial<Record<ScreenPosition, number>> = { off_left: -2, left: -1, center: 0, right: 1, off_right: 2 };

/** Horizontal screen direction of one blocking entry: -1 leftward, 1 rightward, 0 none. */
export function screenDirection(from?: ScreenPosition, to?: ScreenPosition): number {
  const a = from ? POS_X[from] : undefined;
  const b = to ? POS_X[to] : undefined;
  if (a === undefined || b === undefined || a === b) return 0;
  return b > a ? 1 : -1;
}

function shotText(shot: Shot): string {
  return [shot.intent, ...shot.beats.map((b) => b.action), shot.camera.note ?? "", shot.frames?.first ?? "", shot.frames?.last ?? "", ...(shot.blocking ?? []).map((b) => b.note ?? "")].join(" \n ");
}

export interface Fragility {
  score: number;
  reasons: { code: string; message: string }[];
}

/**
 * How likely a shot is to need rerolls: one point per weak spot found.
 * plan_batch renders the most fragile shots first (a probe) and suggests
 * the careful tier for them.
 */
export function shotFragility(shot: Shot, elements: LintElement[] = []): Fragility {
  const text = shotText(shot);
  const reasons: Fragility["reasons"] = [];
  for (const p of FRAGILE_PATTERNS) if (p.re.test(text)) reasons.push({ code: p.code, message: `${p.label}: ${p.advice}` });
  const chars = shot.characters?.length ?? 0;
  if (chars >= 3 && !reasons.some((r) => r.code === "crowd")) reasons.push({ code: "crowd", message: `${chars} characters in one generation; keep two or three readable people` });
  const c = shot.cinematography ?? {};
  if (c.angle === "overhead" && chars > 0) reasons.push({ code: "topdown", message: "overhead angle on characters: the faces disappear and identity drifts" });
  if (shot.beats.length >= 3 && chars === 1 && !reasons.some((r) => r.code === "chain")) reasons.push({ code: "chain", message: `${shot.beats.length} beats for one person in one generation; H3 averages the turns` });
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const id of shot.characters ?? []) {
    const el = byId.get(id);
    const lr = el?.fixedFeatures?.filter((f) => /\b(left|right)\b|左|右/i.test(f.where));
    if (lr?.length) reasons.push({ code: "asymmetric", message: `${el!.name} has a one-sided feature (${lr.map((f) => `${f.feature}, ${f.where}`).join("; ")}); it flips or vanishes — keep it in both frames` });
  }
  if ((shot.dialogue?.length ?? 0) > 0) reasons.push({ code: "dialogue", message: "spoken lines are unverified on H3" });
  return { score: reasons.length, reasons };
}

/**
 * Staging, wording and fragility findings on a shotlist in save_shotlist
 * shape. Merged into lintShotlist's answer.
 */
export function lintCraft(list: Shotlist, opts: CraftOptions = {}): Warning[] {
  const W: Warning[] = [];
  const shots = flatShots(list);
  const n = shots.length;
  const elements = opts.elements ?? [];

  for (const { scene, shot, index } of shots) {
    const where = { scene: scene.slug, shot: index };
    const beatText = shot.beats.map((b) => b.action).join(" \n ");

    /* What moves. A shot where nothing moves reads as a still image. */
    if (shot.motion === undefined) {
      W.push({ code: "motion.missing", severity: "info", ...where, message: "say what moves in the picture (motion: camera, subject, focus, light, foreground, background, weather, prop); if you cannot name one, the shot is not designed yet" });
    } else {
      const moving = shot.motion.filter((m) => m !== "camera" || shot.camera.move !== "static");
      if (moving.length === 0) W.push({ code: "motion.dead", severity: "warn", ...where, message: "nothing moves: a static camera with no moving subject, light or passer-by is a dead frame. Let someone enter or leave, or something drift across" });
      if (shot.camera.move === "static" && shot.motion.length === 1 && shot.motion[0] === "camera") W.push({ code: "motion.contradiction", severity: "warn", ...where, message: "motion says the camera moves but the move is static" });
    }

    /* Staging in screen terms. */
    if ((shot.characters?.length ?? 0) > 0 && !(shot.blocking?.length)) {
      W.push({ code: "blocking.missing", severity: "info", ...where, message: "no blocking: write who enters, crosses or leaves which side of the frame (screen left / right)" });
    }
    if (LOOSE_DIRECTION.test(beatText) && !SCREEN_ANCHORED.test(beatText)) {
      W.push({ code: "wording.direction", severity: "info", ...where, message: "a direction without a frame: write 'toward frame left', not 'to the left' — the model walks people the wrong way otherwise" });
    }
    if (NEGATION.test(beatText)) {
      W.push({ code: "wording.negation", severity: "info", ...where, message: "negations ('no', 'does not', '不要') often do the opposite; say what happens instead ('the spout stays dry' → keep the kettle out of the action; 'only the two people of the first frame appear')" });
    }
    if (SIMULTANEOUS.test(beatText)) {
      W.push({ code: "performance.simultaneous", severity: "info", ...where, message: "people reacting at the same instant reads as machine-made; stagger them ('the father first … a beat later the grandmother … the girl last') and pose them differently in the first frame" });
    }

    /* Elements named in the beats but not listed on the shot appear from nowhere. */
    const listed = new Set([...(shot.characters ?? []), ...(shot.props ?? []), ...(shot.location ? [shot.location] : []), ...(scene.location ? [scene.location] : [])]);
    for (const el of elements) {
      if (listed.has(el.id) || el.name.trim().length < 2) continue;
      const name = el.name.trim().toLowerCase();
      if (beatText.toLowerCase().includes(name)) {
        W.push({ code: "props.unlisted", severity: "info", ...where, message: `"${el.name}" is in the beats but not on the shot; list it (${el.kind}) and make sure the first frame shows it, or it appears out of nowhere` });
      }
    }

    /* Frame-driven shots: describe the first and last frames before drawing them. */
    const frameDriven = shot.mode === "keyframe" || (shot.link && ["continuous", "bridge", "insert_return", "reverse", "jump_cut", "loop"].includes(shot.link.type));
    if (frameDriven && !(shot.frames?.first || shot.frames?.last)) {
      W.push({ code: "frames.missing", severity: "info", ...where, message: "write frames.first / frames.last (who stands where, facing where, which props show) and have them reviewed before any frame is drawn" });
    }

    /* Handles for the edit. */
    if (shot.screenS !== undefined && shot.durationS < shot.screenS + 0.5) {
      W.push({ code: "duration.handles", severity: "warn", ...where, message: `screenS ${shot.screenS}s leaves no handle in a ${shot.durationS}s generation; render at least screenS + 0.5 s` });
    }

    /* The pictures video models get wrong. */
    const fragility = shotFragility(shot, elements);
    for (const r of fragility.reasons) {
      if (r.code === "cartoon" && !opts.animated) continue;
      W.push({ code: `fragile.${r.code}`, severity: "info", ...where, message: r.message });
    }
  }

  /* Screen direction across cuts (the 180° line): the same character keeps its direction from shot to shot. */
  for (let i = 1; i < n; i++) {
    const a = shots[i - 1].shot, b = shots[i].shot;
    if (b.link?.type === "reverse") continue;
    for (const bb of b.blocking ?? []) {
      const ab = (a.blocking ?? []).find((x) => x.who === bb.who);
      if (!ab) continue;
      const da = screenDirection(ab.from, ab.to), db = screenDirection(bb.from, bb.to);
      if (da !== 0 && db !== 0 && da !== db) {
        W.push({ code: "blocking.axis", severity: "warn", scene: shots[i].scene.slug, shot: i, message: `${bb.who} moves ${da > 0 ? "left→right" : "right→left"} in the previous shot and ${db > 0 ? "left→right" : "right→left"} here: the cut crosses the line. Keep the direction, or show the turn` });
      }
      if (ab.to === "off_right" && bb.from === "off_right" || ab.to === "off_left" && bb.from === "off_left") {
        W.push({ code: "blocking.exit", severity: "warn", scene: shots[i].scene.slug, shot: i, message: `${bb.who} leaves through one side and comes back in through the same side: exit frame right, enter frame left` });
      }
    }
  }

  /* Angles and sizes: eye-level frontal at most twice, no run of one size. */
  const eye = shots.filter((s) => s.shot.cinematography?.angle === "eye").length;
  if (n >= 4 && eye > 2) W.push({ code: "rhythm.eyelevel", severity: "info", message: `${eye} eye-level shots; keep straight-on eye level to two and use high, low, from behind, over the shoulder or through something for the rest` });
  let run = 1;
  for (let i = 1; i < n; i++) {
    const a = shots[i - 1].shot.cinematography?.size, b = shots[i].shot.cinematography?.size;
    run = a && a === b ? run + 1 : 1;
    if (run === 3) W.push({ code: "rhythm.sizerun", severity: "warn", scene: shots[i].scene.slug, shot: i, message: `three ${b} shots in a row; alternate full, medium and close` });
  }

  return W;
}

/** Scan free text (a treatment, a script) for the fragile pictures. */
export function fragileInText(text: string, animated = false): { code: string; message: string }[] {
  return FRAGILE_PATTERNS.filter((p) => (p.code !== "cartoon" || animated) && p.re.test(text)).map((p) => ({ code: p.code, message: `${p.label}: ${p.advice}` }));
}
