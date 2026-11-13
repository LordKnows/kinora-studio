import type { ElementState, LintElement, Shotlist, StateSlots, Warning } from "./types.js";
import { flatShots } from "./types.js";

/*
 * The state a character, prop or place carries from shot to shot: what they
 * wear now, what is in their hands, what they are like (soaked, wounded, a
 * door standing open) — where that differs from the element's sheet.
 *
 * A video model keeps no memory between generations. A shot that starts from
 * its anchor's last frame inherits the state in the picture; every other shot
 * is drawn from the sheets, which show the element as it was designed. A
 * state written only in a beat is lost at the next cut, so it is a record on
 * the shot: the compiler writes it into every later prompt, the frame brief
 * draws it, the reviewers read it, and the lint finds the shots that cannot
 * show it.
 *
 * `state` on a shot is how its elements are when the shot ENDS. It holds for
 * every later shot until another entry changes it.
 */

export const STATE_SLOTS = ["wardrobe", "holding", "condition"] as const;

export interface CarriedState extends StateSlots {
  /** Flat index of the shot that last changed it. */
  since: number;
}

export interface ShotStates {
  /** How each element is when the shot starts: what the shots before it left. */
  before: Record<string, CarriedState>;
  /** How each element is when the shot ends. */
  after: Record<string, CarriedState>;
}

function slotsOf(s: StateSlots): StateSlots {
  const out: StateSlots = {};
  for (const k of STATE_SLOTS) if (s[k]?.trim()) out[k] = s[k]!.trim();
  return out;
}

export function sameState(a?: StateSlots, b?: StateSlots): boolean {
  const x = slotsOf(a ?? {}), y = slotsOf(b ?? {});
  return STATE_SLOTS.every((k) => (x[k] ?? "") === (y[k] ?? ""));
}

export function hasState(s?: StateSlots): boolean {
  return !!s && STATE_SLOTS.some((k) => !!s[k]?.trim());
}

/** The state before and after every shot, in story order. */
export function carriedStates(shots: { state?: ElementState[] }[]): ShotStates[] {
  let current: Record<string, CarriedState> = {};
  const clone = (r: Record<string, CarriedState>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v }]));
  return shots.map((shot, index) => {
    const before = clone(current);
    const next = clone(current);
    for (const entry of shot.state ?? []) {
      const was = next[entry.who];
      if (entry.reset) {
        delete next[entry.who];
        continue;
      }
      const merged: StateSlots = { ...(was ? slotsOf(was) : {}) };
      for (const k of STATE_SLOTS) {
        if (entry[k] === undefined) continue;
        if (entry[k]!.trim()) merged[k] = entry[k]!.trim();
        else delete merged[k];
      }
      if (!hasState(merged)) delete next[entry.who];
      else next[entry.who] = { ...merged, since: sameState(was, merged) && was ? was.since : index };
    }
    current = next;
    return { before, after: clone(next) };
  });
}

/** "wearing the grey raincoat, hood up; holding the closed red umbrella; soaked through". */
export function stateText(s: StateSlots): string {
  const x = slotsOf(s);
  return [x.wardrobe ? `wearing ${x.wardrobe}` : "", x.holding ? `holding ${x.holding}` : "", x.condition ?? ""].filter(Boolean).join("; ");
}

/** One prompt line for one element: how it is when the shot starts, or by its end. */
export function stateLine(name: string, s: StateSlots, when: "start" | "end"): string {
  return `${name}, ${when === "start" ? "from the start of the shot" : "by the end of the shot"}: ${stateText(s)}.`;
}

/** The lines a shot's prompt carries for the elements on it. */
export function stateLines(ids: string[], states: ShotStates | undefined, name: (id: string) => string): string[] {
  if (!states) return [];
  const out: string[] = [];
  for (const id of ids) {
    const before = states.before[id], after = states.after[id];
    if (hasState(before)) out.push(stateLine(name(id), before!, "start"));
    if (hasState(after) && !sameState(before, after)) out.push(stateLine(name(id), after!, "end"));
  }
  return out;
}

const NEGATION = /\b(no|not|never|without|don't|doesn't|won't|nothing)\b|不要|没有|不会|别再|不能|禁止/i;
/* Words in a beat that change how someone looks or what they hold. */
const CHANGE = /\b(soaked|drenched|muddy|bloody|bleeding|wounded|bandaged|torn|ripped|puts? on|takes? off|picks? up|drops|hands? (it )?over|changes into|undresses)\b|湿透|淋湿|弄脏|流血|受伤|包扎|撕破|穿上|脱下|拿起|放下|递给|换上/i;
const RESUME_LINKS = new Set(["insert_return", "reverse"]);

/**
 * The shots that cannot show the state they inherit, and records that are
 * missing or malformed. Merged into lintShotlist's answer.
 */
export function lintState(list: Shotlist, opts: { elements?: LintElement[] } = {}): Warning[] {
  const W: Warning[] = [];
  const shots = flatShots(list);
  const states = carriedStates(shots.map((s) => s.shot));
  const names = new Map((opts.elements ?? []).map((e) => [e.id, e.name]));
  const name = (id: string) => names.get(id) ?? id;
  const anyRecord = new Set(shots.flatMap((s) => (s.shot.state ?? []).map((e) => e.who)));
  const hinted = new Set<string>();

  shots.forEach(({ scene, shot, index }, i) => {
    const where = { scene: scene.slug, shot: index };
    const onShot = new Set([...(shot.characters ?? []), ...(shot.props ?? []), ...(shot.location ? [shot.location] : []), ...(scene.location ? [scene.location] : [])]);

    for (const entry of shot.state ?? []) {
      if (!onShot.has(entry.who)) {
        W.push({ code: "state.unlisted", severity: "warn", ...where, message: `state for "${name(entry.who)}", which is not on this shot: a state is how an element is when the shot it appears in ends. List it on the shot (characters, props, location), or move the record to the shot that shows the change` });
      }
      for (const k of STATE_SLOTS) {
        if (entry[k] && NEGATION.test(entry[k]!)) W.push({ code: "state.negation", severity: "info", ...where, message: `${name(entry.who)}'s ${k} reads "${entry[k]}": H3 has no negative prompt, so write what is seen ("bare-headed", "empty hands", "the coat hangs open")` });
      }
    }

    const type = shot.link?.type ?? (shot.linkToPrev === "continuous" ? "continuous" : "cut");
    /* The sheets show an element as designed: a reference-mode shot draws the carried state away. */
    if (shot.mode === "reference" || type === "match_cut") {
      for (const id of shot.characters ?? []) {
        const s = states[i]!.before[id];
        if (!hasState(s)) continue;
        const from = shots[s!.since];
        W.push({ code: "state.reference", severity: "warn", ...where, message: `${name(id)} is ${stateText(s!)} since ${from ? `${from.scene.slug} #${from.index + 1}` : "an earlier shot"}, but this shot renders from the character sheet (reference mode), which shows the designed look: the state is in the prompt only. Render it from a frame that shows it (keyframe mode, or continuous from the shot before), or reset the state if the film has moved on` });
      }
    }
    /* insert_return / reverse resume an earlier frame: what changed since then is not in that frame. */
    if (RESUME_LINKS.has(type)) {
      const anchor = i + (shot.link?.anchor ?? -2);
      for (const id of onShot) {
        const s = states[i]!.before[id];
        if (hasState(s) && s!.since > anchor && anchor >= 0) {
          W.push({ code: "state.resume", severity: "warn", ...where, message: `this ${type} starts from the last frame of shot ${anchor + 1}, but ${name(id)} changed after it (${stateText(s!)}, in shot ${s!.since + 1}): the resumed frame shows the earlier state. Anchor to the shot that shows the change, or draw a first frame for this shot` });
        }
      }
    }
    /* A continuous, bridge or jump_cut shot starts from its anchor's last frame, which already shows the state: nothing to check. */

    /* A change in the beats that nobody recorded. */
    const text = shot.beats.map((b) => b.action).join(" \n ");
    const word = CHANGE.exec(text)?.[0];
    if (word) {
      for (const id of shot.characters ?? []) {
        if (anyRecord.has(id) || hinted.has(id)) continue;
        const later = shots.slice(i + 1).some((x) => (x.shot.characters ?? []).includes(id));
        if (!later) continue;
        hinted.add(id);
        W.push({ code: "state.missing", severity: "info", ...where, message: `the beats change something here ("${word}") and ${name(id)} appears again later, but no shot records a state. If ${name(id)} leaves this shot looking different from the sheet, say so in state (wardrobe, holding, condition): the later prompts, frames and reviews carry it` });
      }
    }
  });
  return W;
}
