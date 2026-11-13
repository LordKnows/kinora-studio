/*
 * From a fault on a take to the fix that fits it.
 *
 * A take fails in one of four ways, and each has its own repair. The picture
 * is wrong (a face, a prop, a count): what the model was shown decides that,
 * so the fix is a painted frame, a change of mode or Viggle Remake. The
 * motion is wrong (the action, its timing, the camera): the beats, the
 * length or the camera field decide that, so the fix is a revision and a new
 * render. The first or last frames are wrong: the edit trims them. The sound
 * is wrong: the timeline mutes or replaces it.
 *
 * On the takes reviewed so far no identity or prop fault was fixed by
 * rewording the prompt (two projects, eight fault-to-fix chains: a small
 * sample). The table sends those to frames and Remake first and says so.
 */

export type FaultClass = "picture" | "motion" | "edge" | "sound" | "other";

/** What a fix changes, cheapest first in every route. */
export type FixKind =
  | "trim"      // the edit: drop the head or tail frames
  | "timeline"  // the edit: retime, mute, freeze, lay a title or a spoken line
  | "remake"    // Viggle Remake from painted frames: the motion stays
  | "frames"    // a new or edited first / last frame, or another mode
  | "state"     // the element's sheet, fixed features or state record
  | "revise"    // the shot's beats, length, camera or lines, then a new render
  | "reroll";   // the same input again, another seed

export interface Fix {
  kind: FixKind;
  how: string;
}

export interface FaultRoute {
  fault: string;
  class: FaultClass;
  fixes: Fix[];
  /** What the records say does not fix it. */
  not?: string;
}

const REWORDING = "rewording the prompt alone: on the takes reviewed so far it never fixed this (small sample)";

export const FAULT_ROUTES: Record<string, Omit<FaultRoute, "fault">> = {
  identity_drift: { class: "picture", not: REWORDING, fixes: [
    { kind: "remake", how: "remake_take mode swap from one painted frame where the face is right: the motion stays" },
    { kind: "frames", how: "render from a frame that shows the face large (keyframe mode with a first and a last frame) instead of from the sheet alone" },
    { kind: "state", how: "check the portrait and the fixed features: a feature the sheet does not show cannot hold" },
  ] },
  wardrobe_or_prop_lost: { class: "picture", not: REWORDING, fixes: [
    { kind: "remake", how: "remake_take mode edit with the garment or prop painted back into one frame" },
    { kind: "frames", how: "an end frame that still shows it, so the model has it at both ends" },
    { kind: "state", how: "record it on the shot (state, fixedFeatures) so the prompt and the frames of later shots carry it" },
  ] },
  object_appears: { class: "picture", not: REWORDING, fixes: [
    { kind: "remake", how: "remake_take mode edit with the stray object painted out" },
    { kind: "frames", how: "put everything the action uses in the first frame and nothing with an obvious use it should not have" },
    { kind: "revise", how: "say what is there as a statement (experiments.positiveCast), never as a ban" },
  ] },
  count_changed: { class: "picture", not: REWORDING, fixes: [
    { kind: "frames", how: "a first frame with exactly that many people or things, each in a different pose, and an end frame with the same count" },
    { kind: "remake", how: "remake_take mode edit when one extra figure can be painted out" },
    { kind: "revise", how: "write the count as a number in the beat and as a Look statement ('exactly two people in the room')" },
  ] },
  face_or_hand_artifact: { class: "picture", fixes: [
    { kind: "trim", how: "cut around it when it lasts a few frames" },
    { kind: "remake", how: "remake_take from a frame where the hand or face is painted right" },
    { kind: "reroll", how: "another seed: this fault is often chance, not the input" },
    { kind: "revise", how: "if it comes back, take the hands out of the action (a small object in a hand is the usual cause)" },
  ] },
  colour_drift: { class: "picture", fixes: [
    { kind: "frames", how: "make the first and last frame agree outside the action: the model interpolates every difference" },
    { kind: "remake", how: "remake_take mode edit for the light or the grade" },
  ] },
  text_artifact: { class: "picture", fixes: [
    { kind: "remake", how: "remake_take mode edit with the lettering painted out" },
    { kind: "timeline", how: "text belongs to the timeline's titles: keep writing out of the frame" },
    { kind: "frames", how: "a first frame with no sign, label or screen in it" },
  ] },
  anthropomorphized: { class: "picture", fixes: [
    { kind: "revise", how: "describe the material and how it moves ('fluffy grey cumulus, cotton texture'), not 'cartoon' or 'cute'" },
    { kind: "remake", how: "remake_take mode edit with the face painted out" },
  ] },
  wrong_direction: { class: "motion", fixes: [
    { kind: "revise", how: "write the direction in screen terms (blocking from / to, 'toward frame left') and render again" },
    { kind: "frames", how: "an end frame with the figure where it should arrive" },
  ], not: "Remake: it copies the motion" },
  simultaneous_motion: { class: "motion", fixes: [
    { kind: "frames", how: "a first frame with everyone in a different pose" },
    { kind: "revise", how: "stagger them in the beats (one first, a beat later the next), or give a reaction its own shot" },
  ], not: "Remake: it copies the motion" },
  action_wrong: { class: "motion", fixes: [
    { kind: "revise", how: "one action per beat with its start and end state and its cause; split a chain of actions across shots" },
    { kind: "frames", how: "an end frame that shows the action's result" },
  ], not: "Remake: it copies the motion" },
  action_timing: { class: "motion", fixes: [
    { kind: "timeline", how: "retime the clip (speed 0.8–1.25) or trim to the action" },
    { kind: "revise", how: "give the action the whole shot, or a longer one, and say its pace in the beat" },
  ], not: "Remake: it copies the timing" },
  camera_wrong: { class: "motion", fixes: [
    { kind: "revise", how: "one camera move in the camera field, static for a locked frame; say the start and end framing in the note" },
    { kind: "frames", how: "an end frame cropped from the first (derive_end_frame) forces a push-in" },
  ], not: "Remake: it copies the camera" },
  weak_camera_move: { class: "motion", fixes: [
    { kind: "frames", how: "an end frame that is the move's destination: a crop of the first frame for a push-in, of the last for a pull-out" },
    { kind: "revise", how: "raise the amplitude, and name the start and end framing in the camera note" },
  ] },
  mouth_moves: { class: "motion", fixes: [
    { kind: "revise", how: "mark the line offscreen or inner so it leaves the prompt, and check the speech rule names the cast" },
    { kind: "timeline", how: "mute the take's own sound and lay the line with speak" },
  ] },
  tail_snap: { class: "edge", fixes: [
    { kind: "trim", how: "tailTrimS on auto_timeline, or the clip's outS" },
    { kind: "frames", how: "if it is long: an end frame the action can reach in the time" },
  ] },
  first_frame_pop: { class: "edge", fixes: [
    { kind: "trim", how: "auto_timeline drops the first two frames of a frame-driven take; raise the clip's inS if it lasts longer" },
  ] },
  audio_music_leak: { class: "sound", fixes: [
    { kind: "timeline", how: "muteOwnAudio on the clip (a review with audioOk: false does it)" },
    { kind: "revise", how: "music stays N/A on the shot; the score is the timeline's" },
  ] },
  audio_bad: { class: "sound", fixes: [
    { kind: "timeline", how: "muteOwnAudio on the clip, and lay the line or the effect on the timeline" },
    { kind: "reroll", how: "another seed only when the picture can go too: the sound is generated with it" },
  ] },
  other: { class: "other", fixes: [{ kind: "revise", how: "say in the review's notes what failed, then choose: the edit, a frame, or the shot" }] },
};

/** The route for each fault, in the order given; an unknown tag gets the general one. */
export function faultRoutes(faults: string[]): FaultRoute[] {
  return [...new Set(faults)].map((fault) => ({ fault, ...(FAULT_ROUTES[fault] ?? FAULT_ROUTES.other!) }));
}

export function faultClass(fault: string): FaultClass {
  return (FAULT_ROUTES[fault] ?? FAULT_ROUTES.other!).class;
}

/** The faults whose picture decides them: a new prompt alone is the wrong tool. */
export function pictureFaults(faults: string[]): string[] {
  return [...new Set(faults)].filter((f) => faultClass(f) === "picture" && !!FAULT_ROUTES[f]?.not);
}

/** One line per fault: what to try first. */
export function fixSummary(faults: string[]): string[] {
  return faultRoutes(faults).map((r) => `${r.fault}: ${r.fixes[0]!.how}${r.not ? ` (not ${r.not})` : ""}`);
}
