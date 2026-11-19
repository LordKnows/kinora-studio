import type { Warning } from "../types.js";

/*
 * What a Look is for.
 *
 * The Look (genre, palette, camera, lens, lighting) and its constraints go into
 * the prompt of every shot of the film. A line written for some scenes only
 * ("Jiangnan scenes: cold grey daylight", "Night exteriors: …") is read by the
 * model as a description of every shot, so an interior, a night scene or a
 * shot of another place is pulled toward it. Place and weather light belongs in
 * the scene's colour script (set_scene_palette), a shot's own light in its
 * cinematography, an object that is in some shots only (a plaque over a door)
 * in an element on those shots.
 *
 * A scope label is a sure sign (no built-in style has one); a time or weather
 * word in the lighting is only a lead (some styles have "dusk" on purpose).
 */

/** "Jiangnan scenes:", "Night exteriors -", "in the temple scenes", "for the rain sequences", "江南场景：", "在祠堂的戏里". */
const SCOPE_LABEL = /\b[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3}\s+(?:scenes?|sequences?|interiors?|exteriors?)\s*[:：—–-]|\b(?:in|for|during)\s+(?:the\s+)?[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3}\s+(?:scenes?|sequences?)\b|[\p{Script=Han}]{1,8}(?:场景|戏份|段落)\s*[:：，,]|在[\p{Script=Han}]{1,8}的?(?:场景|戏)(?:里|中)/iu;

/** Times of day and weather that hold for some scenes, not all of them ("daylight" alone is a plain light and is not listed). */
const TIME_OR_WEATHER = /\b(?:sunrise|sunset|dusk|dawn|twilight|golden hour|night(?:time)?|moonlight|rain(?:y|ing)?|fog(?:gy)?|mist(?:y)?|snow(?:y|ing)?|overcast|storm(?:y)?)\b|清晨|黄昏|日落|日出|傍晚|夜晚|夜景|夜里|月光|雨|雾|雪|阴天/i;

const FIELDS = ["genre", "palette", "camera", "lens", "lighting"] as const;

export interface LookScopeInput {
  genre?: string;
  palette?: string;
  camera?: string;
  lens?: string;
  lighting?: string;
  /** the Look's constraints (`look.negative`) */
  negative?: readonly string[];
}

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** What the Look says about some scenes only, by where: the fields with a scope label (and the words), the
    time or weather the lighting names, the constraints with a scope label. The web's Look page reads this. */
export function lookScope(look: LookScopeInput): { scoped: Array<{ field: (typeof FIELDS)[number]; text: string }>; timed?: string; constraints: string[] } {
  const scoped: Array<{ field: (typeof FIELDS)[number]; text: string }> = [];
  for (const f of FIELDS) {
    const v = look[f];
    const m = v ? SCOPE_LABEL.exec(v) : null;
    if (v && m) scoped.push({ field: f, text: m[0].trim() });
  }
  const timed = look.lighting ? TIME_OR_WEATHER.exec(look.lighting) : null;
  return {
    scoped,
    ...(look.lighting && timed && !SCOPE_LABEL.test(look.lighting) ? { timed: timed[0] } : {}),
    constraints: (look.negative ?? []).filter((c) => SCOPE_LABEL.test(c)),
  };
}

/** Lint over what the Look says about some scenes only. */
export function lintLookScope(look: LookScopeInput): Warning[] {
  const out: Warning[] = [];
  const found = lookScope(look);
  for (const { field, text } of found.scoped) {
    out.push({
      code: "look.scoped", severity: "warn",
      message: `The Look's ${field} reads as true of some scenes only ("${clip(text)}"), but the Look goes into every shot, and the model cannot tell which: keep in the Look what holds for the whole film; a place's or a weather's light goes in that scene's colour script (set_scene_palette), a shot's own light in its cinematography.lighting`,
    });
  }
  if (found.timed) {
    out.push({
      code: "look.lighting.timed", severity: "info",
      message: `The Look's lighting names a time or weather ("${found.timed}"): it is written into every shot, interiors and other times of day included. If only some scenes are like this, put it in their colour script (set_scene_palette) or the shot's cinematography.lighting`,
    });
  }
  const scoped = found.constraints;
  if (scoped.length) {
    out.push({
      code: "look.constraints.scoped", severity: "warn",
      message: `Look constraints written for some scenes only go into every shot's prompt, and what they name is drawn in all of them (${scoped.map((c) => `"${clip(c.trim())}"`).join(", ")}): something that is in some shots only (a plaque over a door) is an element, put on those shots; remove it from the Look`,
    });
  }
  return out;
}
