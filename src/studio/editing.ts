/* Tier 2 of the director: how one shot connects to another, as data the
   compiler can act on. Each link names a mechanism (which frame of which
   earlier shot feeds which H3 workflow); the timeline handles what the model
   cannot (dissolves, audio overlaps). */

export const LINK_TYPES = ["cut", "continuous", "bridge", "insert_return", "reverse", "match_cut", "jump_cut", "montage"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export type LinkMechanism = "none" | "anchor_first_frame" | "anchor_reference";

export const EDIT_GRAMMAR: Array<{
  type: LinkType;
  label: string;
  mechanism: LinkMechanism;
  defaultAnchor: number;
  workflow: string;
  when: string;
  how: string;
}> = [
  { type: "cut", label: "Hard cut", mechanism: "none", defaultAnchor: -1, workflow: "T2VA / I2VA (own hero frame) / R2VA", when: "new angle, new place, new idea; the default", how: "The shot stands on its own: text, its own hero frame, or element references." },
  { type: "continuous", label: "Continuous (long take)", mechanism: "anchor_first_frame", defaultAnchor: -1, workflow: "I2VA, or FL2VA when the shot has an end frame", when: "one unbroken camera move or action longer than 15 s", how: "First frame = the previous shot's last frame, so the pieces join invisibly. Keep the camera move and light consistent with the previous shot." },
  { type: "bridge", label: "Bridge (first → last frame)", mechanism: "anchor_first_frame", defaultAnchor: -1, workflow: "FL2VA (end frame required)", when: "a transition between two looks or places that should be one move: a push into a window that becomes the next room", how: "First frame = previous last frame, last frame = this shot's chosen end frame; the model invents the journey between." },
  { type: "insert_return", label: "Insert, then return", mechanism: "anchor_first_frame", defaultAnchor: -2, workflow: "I2VA", when: "after a cutaway (an insert, a reaction), come back to the main action where it left off", how: "First frame = the last frame of the shot before the insert (anchor offset -2), so the main action resumes seamlessly." },
  { type: "reverse", label: "Shot / reverse shot", mechanism: "anchor_first_frame", defaultAnchor: -2, workflow: "I2VA", when: "dialogue: A, B, A, B", how: "Each return to a speaker starts from that speaker's own last frame (anchor -2 for A/B/A; set the anchor explicitly for longer patterns). Use over-the-shoulder sizes and keep screen direction (the 180° line)." },
  { type: "match_cut", label: "Match cut", mechanism: "anchor_reference", defaultAnchor: -1, workflow: "R2VA", when: "a new place or time that rhymes with the previous image: a spinning wheel to a spinning galaxy, a closing door to a closing eye", how: "The previous last frame goes in as reference image 1 (composition and motion), the new scene is described in text; the LOOK keeps the match readable." },
  { type: "jump_cut", label: "Jump cut", mechanism: "anchor_first_frame", defaultAnchor: -1, workflow: "I2VA", when: "same setup, time has passed: waiting, a montage of attempts", how: "First frame = previous last frame; the beats say what changed (light, props, posture). Written as 'time has passed' so the model moves on instead of continuing." },
  { type: "montage", label: "Montage beat", mechanism: "none", defaultAnchor: -1, workflow: "T2VA / I2VA / R2VA, 5 s", when: "a run of short shots carrying one idea (training, a journey, a day passing)", how: "Keep each at the minimum length, one strong image per shot, consistent grade and pace; let the timeline cut on rhythm." },
];

export const TIMELINE_ONLY = [
  "Dissolve / cross-fade: set `transition: dissolve` on the clip in the timeline; do not ask the model for it.",
  "J-cut / L-cut (audio leads or trails the picture): not available yet — the assembler keeps each clip's own audio. TODO.",
  "Fade to black, titles: TODO in the assembler.",
];

export function grammarFor(type: LinkType) {
  return EDIT_GRAMMAR.find((g) => g.type === type)!;
}

/* ---------- Tier 1 → 2: a deterministic duration plan ---------- */

export type DurationPlan = { totalSeconds: number; shots: number; durations: number[]; note: string };

/** Split a total running time into 5–15 s shots. The agent can reshape it;
    this only guarantees the arithmetic works under H3's limits. */
export function planDurations(totalSeconds: number, shotsWanted?: number, avg = 7): DurationPlan {
  const total = Math.max(5, Math.round(totalSeconds));
  let shots = shotsWanted && shotsWanted > 0 ? shotsWanted : Math.max(1, Math.round(total / avg));
  shots = Math.min(Math.max(shots, Math.ceil(total / 15)), Math.floor(total / 5) || 1);
  const base = Math.floor(total / shots);
  let remainder = total - base * shots;
  const durations = Array.from({ length: shots }, () => base);
  /* Hand the leftover seconds out one at a time so no slot balloons. */
  for (let i = 0; remainder > 0 && i < shots * 15; i++) {
    const idx = i % shots;
    if (durations[idx]! < 15) {
      durations[idx]! += 1;
      remainder -= 1;
    }
  }
  const note = durations.every((d) => d >= 5 && d <= 15)
    ? `${shots} shots averaging ${(total / shots).toFixed(1)} s. Give establishing and emotional beats the longer slots; montage beats the 5 s ones.`
    : `${total} s cannot be tiled with ${shots} shots of 5–15 s; the plan uses ${durations.length} shots.`;
  return { totalSeconds: total, shots: durations.length, durations, note };
}
