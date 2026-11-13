import * as director from "@/director";

import { audioInputs, hashOf, renderHash, reviewState, takeRenderHash, isRejected, autopilotActive, fixLedger, fixTally, retakeChanges, retakeRecord } from "./craft-core";
import { StudioError } from "./errors";
import { VIDEO_SIZES } from "./compiler";
import { frameStateLines } from "./imaging";
import { compileForShot, getProjectView, lintProject, type ProjectView, type ShotView } from "./orchestrator";
import * as repo from "./repo";
import * as treatments from "./treatment";
import type { Actor, Delegation, DirectorNote, Project, ReviewFinding, ReviewStage, Script, StageReview } from "./types";

/*
 * The cold reader. The agent that wrote the story and the shots has talked
 * with the user for an hour and fills every gap from memory; a reviewer that
 * has seen nothing else reads like a first-time viewer. A packet holds only
 * the material of one stage (story, shot before render, finished film) and a
 * checklist; the director hands it to a fresh subagent, which finds faults
 * and edits nothing, and records the verdict. A verdict is stored against a
 * hash of what was reviewed: revise the prompt or swap a frame and it lapses.
 */

const FRAGILE_LIST = "people crossing, small objects in hands, readable text, mirrors and reflections, one-sided features (a tattoo on one arm), a light change inside one shot, one person doing three things, overhead shots that hide faces, too many extras";

const HOW_TO_RUN = [
  "Hand `reviewerPrompt` (it already contains the material and the checklist) to a FRESH reviewer that has seen nothing else of this project:",
  "Claude Code → spawn a subagent with only this text; claude.ai → a new chat; any client → a second model.",
  "The reviewer only finds faults and changes nothing. Do not add your own explanation of what you meant: that is exactly the gap it is there to find.",
  "Then call record_review with its verdict, its findings verbatim, reviewer 'fresh_agent', and basis = what it looked at.",
  "If you cannot start a fresh reviewer, review it yourself, record reviewer 'self', and tell the user the review was not independent.",
].join(" ");

export type ReviewPacket = {
  stage: ReviewStage;
  shotId?: string;
  subjectHash: string;
  current: Awaited<ReturnType<typeof reviewState>>["state"];
  howToRun: string;
  reviewerPrompt: string;
  materials: Record<string, unknown>;
};

/** The packet for one stage. */
/** `targetId` is the shot (stage shot) or the generated picture (stage frame). */
export async function reviewPacket(projectId: string, stage: ReviewStage, targetId?: string): Promise<ReviewPacket> {
  if (stage === "story") return storyPacket(projectId);
  if (stage === "shot") {
    if (!targetId) throw new StudioError("validation", "stage 'shot' needs shotId");
    return shotPacket(projectId, targetId);
  }
  if (stage === "frame") {
    if (!targetId) throw new StudioError("validation", "stage 'frame' needs assetId");
    return framePacket(projectId, targetId);
  }
  return filmPacket(projectId);
}

/* ---- frame: one generated picture against what it was asked to be ---- */

/** The fault codes a frame reviewer files under (the painter's own self-check uses the same list). */
export const FRAME_FAULTS = ["anatomy", "count", "identity", "wardrobe", "feature_side", "text", "framing", "aspect", "style", "background", "extra", "edit_scope", "prompt_mismatch", "other"] as const;

async function framePacket(projectId: string, assetId: string): Promise<ReviewPacket> {
  const view = await getProjectView(projectId);
  const asset = view.assets.find((a) => a.id === assetId);
  if (!asset || asset.kind !== "image") throw new StudioError("not_found", `image ${assetId} not in project ${projectId}`);
  const m = asset.meta as Record<string, unknown>;
  const base = typeof m.baseAssetId === "string" ? view.assets.find((a) => a.id === m.baseAssetId) : undefined;
  const shot = view.scenes.flatMap((s) => s.shots).find((sh) => sh.heroAssetId === asset.id || sh.endAssetId === asset.id);
  const element = view.elements.find((e) => e.refAssetIds.includes(asset.id));
  const sheets = shot ? view.elements.filter((e) => shot.spec.characters.includes(e.id) || shot.spec.props.includes(e.id)).map((e) => ({ name: e.name, fixedFeatures: e.fixedFeatures ?? [], refs: e.refAssetIds.filter((a) => a !== asset.id).map((a) => view.assets.find((x) => x.id === a)?.url).filter(Boolean) })) : [];
  /* the pictures it was drawn from, in the order the painter attached them */
  const job = typeof m.jobId === "string" ? await repo.getJob(m.jobId).catch(() => undefined) : undefined;
  const refsUsed = ((job?.input.refUrls as string[] | undefined) ?? []).map((url, k) => ({ n: k + 1, url, name: view.assets.find((a) => a.url === url)?.name }));
  const flatShots = view.scenes.flatMap((s) => s.shots);
  const which = shot ? (shot.heroAssetId === asset.id ? "first" as const : "last" as const) : undefined;
  const carried = shot && which ? frameStateLines(shot, which, director.carriedStates(flatShots.map((s) => s.spec))[flatShots.findIndex((s) => s.id === shot.id)], (id) => view.elements.find((e) => e.id === id)?.name ?? id) : [];
  const materials = {
    picture: asset.url, handle: asset.handle, name: asset.name, size: asset.width ? `${asset.width}×${asset.height}` : undefined, purpose: m.purpose, askedFor: m.prompt, base: base?.url, diff: m.diffUrl, region: m.region,
    refsUsed,
    shot: shot ? { intent: shot.spec.intent, frames: shot.spec.frames, blocking: shot.spec.blocking, composition: shot.spec.composition, characters: shot.spec.characters.map((c) => view.elements.find((e) => e.id === c)?.name ?? c), which, carriedState: carried.length ? carried : undefined, other: shot.heroAssetId === asset.id ? shot.end?.url : shot.hero?.url } : undefined,
    element: element ? { name: element.name, kind: element.kind, description: element.description, fixedFeatures: element.fixedFeatures ?? [], view: element.refViews?.[asset.id], detailOf: element.refFeatures?.[asset.id], otherViews: element.refAssetIds.filter((a) => a !== asset.id).map((a) => ({ url: view.assets.find((x) => x.id === a)?.url, view: element.refViews?.[a] })) } : undefined,
    sheets, renderSize: VIDEO_SIZES[view.project.look.aspectRatio],
    /* measured on the pixels by the painter: facts, not opinions */
    pixelChecks: m.checks,
    /* a first checker (Codex) — leads to confirm or reject, not a verdict to copy */
    firstChecker: m.autoReview ? { verdict: (m.autoReview as { verdict?: string }).verdict, findings: (m.autoReview as { findings?: unknown }).findings } : undefined,
  };
  const reviewerPrompt = [
    "You are the reviewer of one generated picture that a video model will copy into every frame of a shot. Read only, change nothing.",
    "Open the picture at FULL size (the url, not a thumbnail) and every reference beside it. Do your own pass first, top to bottom, before reading firstChecker.",
    "",
    "Check, and file every fault under one code:",
    "1. anatomy — hands (count the fingers on every visible hand), arms, legs, faces, eyes, teeth; nothing fused, doubled, melted or missing.",
    "2. count / extra — exactly the people and props asked for (shot.characters, askedFor); no extra person in the background, no duplicate of a character, nothing added that was not asked.",
    "3. identity / wardrobe — put the picture next to each sheet (refsUsed, sheets): face shape, hairline and hair colour, eye colour, age, build, every garment and its colour, props. 'Similar' is a fault: the video will drift further. Where shot.carriedState says how someone is at this moment (what they wear now, what they hold, soaked, wounded), the picture shows that and not the sheet's look: a dry coat on someone the story left soaked is a blocker.",
    "4. feature_side — every fixed feature on the side the sheet puts it, as the PERSON's own left/right (a scar on her left cheek is on the right side of the picture when she faces the camera). A mirrored person is a blocker.",
    "5. text — letters, numbers, captions, labels, logos, watermarks, signatures, borders, panel grids, letterbox bars.",
    "6. framing / aspect — the render is " + materials.renderSize + ": heads, hands or feet cut that should be in, the subject's eyes on the composition line (shot.composition), headroom; a sheet shows the whole figure.",
    "7. style / background — the film's style; a sheet view: ONE figure, the asked view (front, side, back, expressions), plain empty backdrop; a frame: the right place, same camera, scale and background as the shot's other frame.",
    "8. edit_scope — with a base: outside the region everything identical (the diff is black there); the edit did what was asked and nothing else.",
    "9. prompt_mismatch — anything else askedFor wants and the picture does not show: everything the action needs already visible in a first frame, room for the movement, people in different poses.",
    "",
    "Then go through pixelChecks (measured, so they are true unless the check misread the picture) and each firstChecker finding: confirm it with what you see, or reject it. Do not copy anything you did not see yourself.",
    "",
    "For each finding write: code, severity (blocker = a viewer would notice it or the video model would copy it; minor = a nit), where (a body part, or a box as fractions x,y,w,h of the picture), the problem, and the fix as ONE of:",
    "  'edit: <instruction>' with the box — for a local fault (a hand, a garment, a face, a stray object): edit_frame with that region fixes it without touching the rest;",
    "  'redraw: <what to change in the request>' — for a global fault (wrong person count, wrong camera, wrong style, mirrored person).",
    "A picture with any blocker FAILS. End with exactly one word on its own line: PASS or FAIL.",
    "",
    "--- MATERIAL ---",
    JSON.stringify(materials, null, 2),
  ].join("\n");
  return { stage: "frame", shotId: assetId, subjectHash: hashOf(asset.url), current: (await reviewState(projectId, "frame", hashOf(asset.url), assetId)).state, howToRun: HOW_TO_RUN, reviewerPrompt, materials };
}

/* ---- story: the script text and nothing else ---- */

async function storyPacket(projectId: string): Promise<ReviewPacket> {
  const project = await repo.getProject(projectId);
  const script = await repo.latestScript(projectId);
  if (!script) throw new StudioError("validation", "no script yet; save_script first");
  const subjectHash = hashOf(script.text);
  const stored = await treatments.currentTreatment(projectId);
  const reviewerPrompt = [
    "You are reading a short film's script for the first time. You only find faults; you change nothing.",
    project.targetSeconds ? `Running time: ${project.targetSeconds} s.` : "",
    "",
    "1. Read it in order, then write the story as you understood it, in three sentences.",
    "2. Ask every turn the way reality would: why does this happen? Where does the thing come from? Is it within reach? Would it really go like this?",
    "3. Can you say in one sentence what the film is about? Write that sentence, or say that you cannot.",
    "4. Does the opening hook in the first three seconds? Is the most striking picture near the start?",
    "5. Do the other people react like real people — one after another, not in unison, with bodies that flinch back when startled?",
    `6. Which moments will an AI video model get wrong? (${FRAGILE_LIST})`,
    stored
      ? "7. The director's treatment is below. Read it only after you have written your own three sentences. Does the script deliver its logline, its turn and its ending? Does the hook it names open the film? Is the chosen structure the one on the page, or one of the two it set aside? Where the script and the treatment disagree, that is a finding."
      : "7. There is no treatment with this script: nobody wrote down what the film is for or which structure was chosen over which. Say so as a finding.",
    "",
    "For each finding write: where (scene / line), the problem, a suggested fix. Mark uncertain findings as 'maybe'.",
    "End with exactly one word on its own line: PASS or FAIL.",
    "",
    "--- SCRIPT ---",
    script.text,
    ...(stored ? ["", `--- TREATMENT (written for script v${stored.scriptVersion}) ---`, director.treatmentToMarkdown(stored.treatment)] : []),
  ].filter((l) => l !== undefined).join("\n");
  return { stage: "story", subjectHash, current: (await reviewState(projectId, "story", subjectHash)).state, howToRun: HOW_TO_RUN, reviewerPrompt, materials: { scriptVersion: script.version, targetSeconds: project.targetSeconds, treatment: stored ? { scriptVersion: stored.scriptVersion, warnings: stored.warnings.filter((w) => w.severity !== "info") } : null } };
}

/* ---- shot: everything that is about to be sent to the GPU ---- */

function shotLabel(view: ProjectView, sh: ShotView): string {
  const scene = view.scenes.find((s) => s.id === sh.sceneId);
  return `${scene?.slug ?? "?"} #${sh.index + 1}`;
}

async function shotPacket(projectId: string, shotId: string): Promise<ReviewPacket> {
  const view = await getProjectView(projectId);
  const flat = view.scenes.flatMap((s) => s.shots);
  const i = flat.findIndex((s) => s.id === shotId);
  if (i < 0) throw new StudioError("not_found", `shot ${shotId} not in project ${projectId}`);
  const sh = flat[i]!;
  const scene = view.scenes.find((s) => s.id === sh.sceneId)!;
  const compiled = await compileForShot(shotId);
  const subjectHash = renderHash(compiled.workflow, compiled.prompt, compiled.input.images, audioInputs(compiled.input));
  const ids = new Set([...sh.spec.characters, ...sh.spec.props, ...(sh.spec.location ? [sh.spec.location] : [])]);
  const assetUrl = new Map(view.assets.map((a) => [a.id, a]));
  const elements = view.elements.filter((e) => ids.has(e.id)).map((e) => ({
    name: e.name, kind: e.kind, description: e.description, fixedFeatures: e.fixedFeatures ?? [],
    refs: e.refAssetIds.map((a) => ({ url: assetUrl.get(a)?.url, view: e.refViews?.[a] })).filter((r) => r.url),
  }));
  const neighbour = (s?: ShotView) => s && ({
    label: shotLabel(view, s), intent: s.spec.intent, frames: s.spec.frames, blocking: s.spec.blocking, link: s.spec.link?.type,
    lastFrameOfPick: (s.selectedTake ?? s.takes.find((t) => t.status === "completed"))?.lastFrameUrl,
  });
  const requirements = (await repo.listNotes(projectId, "requirement")).filter((n) => n.status === "open").map((n) => n.body.text);
  const images = compiled.input.images.map((img) => {
    const asset = view.assets.find((a) => a.url === img.url);
    return { role: img.role, label: img.label, url: img.url, size: asset?.width ? `${asset.width}×${asset.height}` : undefined };
  });
  const names = (id: string) => view.elements.find((e) => e.id === id)?.name ?? id;
  const states = director.carriedStates(flat.map((s) => s.spec))[i];
  const carriedState = { atStart: frameStateLines(sh, "first", states, names), atEnd: frameStateLines(sh, "last", states, names) };
  const materials = {
    shot: shotLabel(view, sh), workflow: compiled.workflow, seconds: compiled.effectiveSeconds, videoSize: compiled.input.video_size,
    prompt: compiled.prompt, images, spec: {
      intent: sh.spec.intent, beats: sh.spec.beats, camera: sh.spec.camera, cinematography: sh.spec.cinematography, blocking: sh.spec.blocking,
      motion: sh.spec.motion, composition: sh.spec.composition, frames: sh.spec.frames, link: sh.spec.link, sound: sh.spec.sound,
    },
    ...(carriedState.atStart.length || carriedState.atEnd.length ? { carriedState } : {}),
    elements, scenePalette: scene.palette, look: { genre: view.project.look.genre, palette: view.project.look.palette, style: view.project.look.style },
    previous: neighbour(flat[i - 1]), next: neighbour(flat[i + 1]), compilerWarnings: compiled.warnings, openRequirements: requirements,
  };
  const reviewerPrompt = [
    "You are the reviewer. Read only, change nothing. This shot is about to be sent to video generation, which costs real money.",
    "Open every image and look closely (zoom in). The material is below as JSON.",
    "",
    "A. The frames",
    "1. Everything the action uses must already be in the first frame (a cup that is picked up later must be visible now), or it appears from nowhere.",
    "2. Reactions are staged in the first frame: one clip is one shot and cannot cut to someone else, so a person who reacts must already be there, facing the camera.",
    "3. Several people never share one pose, or the model moves them all at once.",
    "4. Room for the action: where something lands or drifts is empty; there is headroom above heads.",
    "5. Wind and cloth agree (a scarf and a sheet blow the same way).",
    "6. Shrink to phone size: is every important person still readable?",
    "7. Zoom in for stray things: an extra kettle, a strange thin line, a sixth finger.",
    "8. Overlay first and last frame: what should not change must be identical (a wall that changes colour fades in the video; a cup that grows, grows).",
    "",
    "B. The prompt against the frames",
    "1. Does every sentence of the prompt match the images? Positions, left/right, colours, how many people, how many props, clothes, expressions.",
    "2. Same camera position, scale and background in both frames?",
    "3. Consistent with the element sheets (fixed features on the right side), the scene palette, the previous and next shot?",
    "   carriedState, when present, is what the shots before left (what each one wears now, holds, is like): the first frame shows atStart and the last frame atEnd, in the pictures and in the prompt. A reference-mode shot draws the sheet's look: say so when the state would be lost.",
    "4. Is every movement physically caused and written so (wind lifts the bag — the hands never touch it)? Where are the hands?",
    "5. Where could the model go wrong: simultaneous actions, things appearing, faces on objects, walking the wrong way, ambiguous words ('the old man behind the window' — which window?), counts not stated.",
    "",
    "For each finding write: where, the problem, the fix. Mark uncertain ones 'maybe'.",
    "End with exactly one word on its own line: PASS or FAIL.",
    "",
    "--- MATERIAL ---",
    JSON.stringify(materials, null, 2),
  ].join("\n");
  return { stage: "shot", shotId, subjectHash, current: (await reviewState(projectId, "shot", subjectHash, shotId)).state, howToRun: HOW_TO_RUN, reviewerPrompt, materials };
}

/* ---- film: the cut, watched like an audience ---- */

async function filmPacket(projectId: string): Promise<ReviewPacket> {
  const view = await getProjectView(projectId);
  const exports = await repo.listExports(projectId);
  const latest = exports.find((e) => e.status === "completed" && e.resultUrl);
  if (!latest) throw new StudioError("validation", "no finished export yet; export_project first");
  let t = 0;
  const cuts = view.timeline.clips.map((c, k) => {
    const len = ((c.outS - c.inS) / (c.speed ?? 1)) * (c.repeat ?? 1) + (c.freezeS ?? 0);
    const row = { clip: k + 1, shotId: c.shotId, startS: Math.round(t * 100) / 100, endS: Math.round((t + len) * 100) / 100 };
    t += len;
    return row;
  });
  const subjectHash = hashOf({ export: latest.id, url: latest.resultUrl });
  const sheet = view.assets.find((a) => a.meta.exportId === latest.id && a.meta.role === "cut-sheet")?.url;
  /* What the assembler measured on the file. The reviewer sees stills and hears nothing, so this is its only word on the sound. */
  const file = view.assets.find((a) => a.source === "export" && a.kind === "video" && a.meta.exportId === latest.id);
  const measured = file?.meta.checks as { lufs?: number | null; true_peak_db?: number | null } | undefined;
  const findings = Array.isArray(file?.meta.findings) ? (file!.meta.findings as string[]) : [];
  const titles = (view.timeline.titles ?? []).map((x) => ({ atS: x.atS, durationS: x.durationS, kind: x.kind, text: x.text }));
  const reviewerPrompt = [
    `This is a finished short film: ${latest.resultUrl}. You are seeing it for the first time; nobody tells you what it means.`,
    "1. Decode all of it. Take several full-resolution frames from every shot, and 3 frames on each side of every cut (cut times below).",
    sheet ? `   A contact sheet of those cut frames is here (one row per cut, 3 before | 3 after): ${sheet}` : "",
    "2. First write the story as you understood it, then list what you did not understand.",
    "3. Check shot by shot: repeated actions, prop counts, continuity errors, jumps, colour jumps at cuts, deformed faces or hands, broken text.",
    "4. Say plainly what you could not check (motion feel, sound) — do not guess about it.",
    "For each finding write: time, frame number, problem; and sort them into 'blocker' and 'minor'.",
    "End with exactly one word on its own line: PASS or FAIL.",
    titles.length ? "5. Read every title, card and caption below against the frames at its time: is it there, whole, readable, held long enough to read, and clear of the faces?" : "",
    measured || findings.length ? "6. The file was measured after it was assembled (below). Every line under FOUND ON THE FILE is a finding unless you can say why it is meant." : "",
    "",
    "--- CUTS ---",
    JSON.stringify(cuts, null, 2),
    titles.length ? "\n--- TITLES ---" : "",
    titles.length ? JSON.stringify(titles, null, 2) : "",
    measured ? `\n--- MEASURED ON THE FILE ---\nloudness ${measured.lufs ?? "?"} LUFS (web platforms play at about -14), true peak ${measured.true_peak_db ?? "?"} dBFS` : "",
    findings.length ? `\n--- FOUND ON THE FILE ---\n${findings.map((f) => `- ${f}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return { stage: "film", subjectHash, current: (await reviewState(projectId, "film", subjectHash)).state, howToRun: HOW_TO_RUN, reviewerPrompt, materials: { exportId: latest.id, url: latest.resultUrl, preset: latest.preset, cutSheet: sheet, cuts, totalS: Math.round(t * 100) / 100 } };
}

/** Store a verdict against the hash of what the packet showed now. */
export async function recordReview(projectId: string, input: { stage: ReviewStage; shotId?: string; verdict: "pass" | "fail"; reviewer: StageReview["reviewer"]; basis: string; findings: ReviewFinding[] }): Promise<{ review: StageReview; note?: string }> {
  const packet = await reviewPacket(projectId, input.stage, input.shotId);
  const sure = input.findings.filter((f) => f.sure !== false);
  if (input.verdict === "pass" && (input.stage === "film" || input.stage === "frame") && input.findings.some((f) => f.severity === "blocker")) {
    throw new StudioError("validation", `a ${input.stage} review with blocker findings cannot pass`);
  }
  const review = await repo.insertReview({ projectId, stage: input.stage, shotId: input.shotId, subjectHash: packet.subjectHash, verdict: input.verdict, reviewer: input.reviewer, basis: input.basis, findings: input.findings });
  /* a frame review marks the picture itself, so the Board and the Remake gate can see it */
  if (input.stage === "frame" && input.shotId) {
    const a = await repo.getAsset(input.shotId).catch(() => undefined);
    if (a) await repo.updateAssetMeta(a.id, { ...a.meta, review: input.verdict, reviewedBy: input.reviewer, reviewFindings: input.findings.slice(0, 20) });
  }
  const note = input.reviewer === "self" ? "Recorded as a self-review: tell the user it was not an independent read." : input.verdict === "pass" && sure.length ? "Passed with findings: fix the sure ones before rendering." : undefined;
  return { review, ...(note ? { note } : {}) };
}

export async function listStageReviews(projectId: string, stage?: ReviewStage, shotId?: string): Promise<StageReview[]> {
  return repo.listReviews(projectId, { stage, shotId });
}

/* ---- the requirements list: everything the user asked for ---- */

export async function addRequirements(projectId: string, items: Array<{ text: string; source?: string }>): Promise<DirectorNote[]> {
  await repo.getProject(projectId);
  const existing = new Set((await repo.listNotes(projectId, "requirement")).map((n) => String(n.body.text).trim().toLowerCase()));
  const out: DirectorNote[] = [];
  for (const it of items) {
    const key = it.text.trim().toLowerCase();
    if (!key || existing.has(key)) continue;
    existing.add(key);
    out.push(await repo.insertNote(projectId, "requirement", "open", { text: it.text.trim(), source: it.source ?? "" }));
  }
  return out;
}

export async function setRequirement(id: string, status: "open" | "met" | "dropped", note?: string): Promise<DirectorNote> {
  const cur = await repo.getNote(id);
  if (cur.kind !== "requirement") throw new StudioError("validation", `${id} is not a requirement`);
  return repo.updateNote(id, { status, body: note ? { note } : {} });
}

/* ---- the decision log ---- */

export async function logDecision(projectId: string, input: { decision: string; why: string; confidence: "low" | "medium" | "high"; shotId?: string; alternatives?: string[] }, actor: Actor): Promise<DirectorNote> {
  await repo.getProject(projectId);
  return repo.insertNote(projectId, "decision", "standing", { ...input, by: actor.via === "mcp" ? "agent" : actor.user });
}

/** The user overturns a decision on the web; the agent reads it on its next
    list. Overturning a delegated approval puts that checkpoint back in draft. */
export async function overturnDecision(id: string, reason: string, actor: Actor): Promise<DirectorNote> {
  const cur = await repo.getNote(id);
  if (cur.kind !== "decision") throw new StudioError("validation", `${id} is not a decision`);
  if (cur.status === "standing" && cur.body.approval === "script" && typeof cur.body.scriptId === "string") {
    const script = await repo.getScript(cur.body.scriptId);
    if (script.approval === "approved") await repo.unapproveScript(script.id);
  }
  if (cur.status === "standing" && cur.body.approval === "shotlist") {
    const project = await repo.getProject(cur.projectId);
    if (project.shotlistApproval === "approved" && (project.shotlistApprovedAt ?? 0) <= cur.createdAt + 5_000) await repo.setShotlistApproval(project.id, "draft");
  }
  return repo.updateNote(id, { status: "overturned", body: { overturnedBy: actor.user, overturnReason: reason, overturnedAt: Date.now() } });
}

/* ---- delegated approvals: the user may let the director pass a checkpoint ---- */

export async function setDelegation(projectId: string, input: { script: boolean; shotlist: boolean }, actor: Actor): Promise<Project> {
  if (actor.via !== "web") throw new StudioError("forbidden", "delegated approval is switched on the web only");
  const project = await repo.getProject(projectId);
  const before = project.delegation ?? { script: false, shotlist: false };
  const next: Delegation | null = input.script || input.shotlist ? { script: input.script, shotlist: input.shotlist, grantedBy: actor.user, grantedAt: Date.now() } : null;
  const updated = await repo.setDelegation(projectId, next);
  if (before.script !== input.script || before.shotlist !== input.shotlist) {
    const on = [input.script && "script", input.shotlist && "shotlist"].filter(Boolean).join(" and ");
    await repo.insertNote(projectId, "decision", "standing", { decision: on ? `the director may approve the ${on}` : "delegated approval switched off", why: "", by: actor.user, confidence: "user" });
  }
  return updated;
}

export function delegationSummary(project: Project) {
  const d = project.delegation;
  return {
    script: !!d?.script, shotlist: !!d?.shotlist, ...(d ? { grantedBy: d.grantedBy, grantedAt: d.grantedAt } : {}),
    rule: "script: only with a passing story review by a fresh reviewer (or the user) of the current text; shotlist: only with the script approved and no lint errors. Every delegated approval is logged; overturning it puts the checkpoint back in draft.",
  };
}

type ApprovalInput = { why: string; confidence: "low" | "medium" | "high" };

/** The director passes checkpoint 1 on the user's behalf. */
export async function agentApproveScript(projectId: string, input: ApprovalInput, actor: Actor): Promise<{ script: Script; decision: DirectorNote }> {
  const project = await repo.getProject(projectId);
  if (!project.delegation?.script) throw new StudioError("forbidden", "approving the script is the user's: they can let you do it on the project's Settings page (delegated approval). Ask them to approve on the Story page.", { checkpoint: "script" });
  if (input.confidence === "low") throw new StudioError("validation", "low confidence: leave this approval to the user and say why");
  const script = await repo.latestScript(projectId);
  if (!script) throw new StudioError("validation", "no script yet");
  if (script.approval === "approved") throw new StudioError("validation", `script v${script.version} is already approved`);
  const review = await reviewStateForStory(projectId, script.text);
  if (review !== "pass") throw new StudioError("not_approved", review === "self" ? "only your own review passed this script; a delegated approval needs a fresh reviewer (or the user)" : "the current script has no passing story review: review_packet stage story → a fresh reviewer → record_review", { checkpoint: "script", review });
  const approved = await repo.approveScript(script.id);
  const decision = await repo.insertNote(projectId, "decision", "standing", { decision: `approved script v${script.version} on the user's behalf`, why: input.why, confidence: input.confidence, by: actor.via === "mcp" ? "agent" : actor.user, approval: "script", scriptId: script.id });
  return { script: approved, decision };
}

/** The director passes checkpoint 2 on the user's behalf. */
export async function agentApproveShotlist(projectId: string, input: ApprovalInput, actor: Actor): Promise<{ project: Project; decision: DirectorNote }> {
  const project = await repo.getProject(projectId);
  if (!project.delegation?.shotlist) throw new StudioError("forbidden", "approving the shotlist is the user's: they can let you do it on the project's Settings page (delegated approval). Ask them to approve on the Board.", { checkpoint: "shotlist" });
  if (input.confidence === "low") throw new StudioError("validation", "low confidence: leave this approval to the user and say why");
  const script = await repo.latestScript(projectId);
  if (!script || script.approval !== "approved") throw new StudioError("not_approved", "approve the script first", { checkpoint: "script" });
  if ((await repo.listShots(projectId)).length === 0) throw new StudioError("validation", "nothing to approve: the shotlist is empty");
  if (project.shotlistApproval === "approved") throw new StudioError("validation", "the shotlist is already approved");
  const lint = await lintProject(projectId);
  if (lint.counts.error > 0) throw new StudioError("validation", `the shotlist has ${lint.counts.error} lint error(s); fix them first`, { errors: lint.warnings.filter((w) => w.severity === "error") });
  const updated = await repo.setShotlistApproval(projectId, "approved");
  const decision = await repo.insertNote(projectId, "decision", "standing", { decision: "approved the shotlist on the user's behalf", why: input.why, confidence: input.confidence, by: actor.via === "mcp" ? "agent" : actor.user, approval: "shotlist", lintWarnings: lint.counts.warn });
  return { project: updated, decision };
}

async function reviewStateForStory(projectId: string, text: string): Promise<"pass" | "self" | "none"> {
  const reviews = (await repo.listReviews(projectId, { stage: "story" })).filter((r) => r.subjectHash === hashOf(text) && r.verdict === "pass");
  if (reviews.some((r) => r.reviewer !== "self")) return "pass";
  return reviews.length ? "self" : "none";
}

/* ---- the spend envelope: granted on the web only ---- */

export async function grantAutopilot(projectId: string, input: { envelopeUsd: number; hours?: number; note?: string }, actor: Actor): Promise<Project> {
  if (actor.via !== "web") throw new StudioError("forbidden", "the spend envelope is granted on the web only");
  const project = await repo.getProject(projectId);
  const remaining = Math.max(0, project.budgetCapUsd - project.spentUsd);
  if (input.envelopeUsd > remaining + 1e-9) throw new StudioError("validation", `the envelope (${input.envelopeUsd} USD) exceeds the budget left (${remaining.toFixed(2)} USD)`);
  const updated = await repo.setAutopilot(projectId, {
    envelopeUsd: input.envelopeUsd, usedUsd: 0, grantedAt: Date.now(), grantedBy: actor.user,
    ...(input.hours ? { expiresAt: Date.now() + input.hours * 3600_000 } : {}), ...(input.note ? { note: input.note } : {}),
  });
  await repo.insertNote(projectId, "decision", "standing", { decision: `granted a ${input.envelopeUsd} USD envelope${input.hours ? ` for ${input.hours} h` : ""}`, why: input.note ?? "", by: actor.user, confidence: "user" });
  return updated;
}

export async function revokeAutopilot(projectId: string, actor: Actor): Promise<Project> {
  if (actor.via !== "web") throw new StudioError("forbidden", "the spend envelope is revoked on the web");
  return repo.setAutopilot(projectId, null);
}

export function autopilotSummary(project: Project) {
  const a = project.autopilot;
  if (!autopilotActive(a)) return { active: false as const, ...(a ? { lapsed: a } : {}) };
  return { active: true as const, envelopeUsd: a.envelopeUsd, usedUsd: a.usedUsd, leftUsd: Math.max(0, a.envelopeUsd - a.usedUsd), expiresAt: a.expiresAt, rule: "inside the envelope, a take with a passing shot review and no identical rejected take renders without asking; everything is written to the decision log" };
}

/* ---- the retro: what this film taught, for the next one ---- */

export async function buildRetro(projectId: string): Promise<string> {
  const view = await getProjectView(projectId);
  const [decisions, requirements, reviews] = await Promise.all([repo.listNotes(projectId, "decision"), repo.listNotes(projectId, "requirement"), repo.listReviews(projectId)]);
  const L: string[] = [`# Retro — ${view.project.name}`, ""];
  const takes = view.scenes.flatMap((s) => s.shots.flatMap((sh) => sh.takes));
  const spent = takes.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  L.push(`Style: ${view.project.look.style ?? "—"} · ${view.scenes.reduce((a, s) => a + s.shots.length, 0)} shots · ${takes.length} takes · ${spent.toFixed(2)} USD on takes · ${view.project.spentUsd.toFixed(2)} USD spent of ${view.project.budgetCapUsd.toFixed(2)}`, "");

  const faults = new Map<string, number>();
  for (const t of takes) for (const f of t.review?.faults ?? []) faults.set(f, (faults.get(f) ?? 0) + 1);
  L.push("## What went wrong on H3", "");
  const done = takes.filter((t) => t.status === "completed");
  const unjudged = done.filter((t) => !t.review);
  if (faults.size === 0) L.push("No take was tagged with faults. Tag rejected takes on the Board so the next film learns from this one.");
  else for (const [f, n] of [...faults].sort((a, b) => b[1] - a[1])) L.push(`- ${f}: ${n}`);
  if (unjudged.length) L.push("", `${unjudged.length} of ${done.length} finished take(s) have no review at all: what failed in them is not in this retro.`);
  L.push("");

  /* How the film was made, in numbers: the checks that ran, what they were worth, what the settings cost. */
  const shotsAll = view.scenes.flatMap((sc) => sc.shots);
  const byStage = (stage: ReviewStage) => reviews.filter((r) => r.stage === stage);
  const independent = (rs: StageReview[]) => rs.filter((r) => r.reviewer !== "self").length;
  const shotReviews = byStage("shot");
  const reviewedShots = new Set(shotReviews.map((r) => r.shotId)).size;
  const rendered = shotsAll.filter((sh) => sh.takes.length > 0).length;
  const skipped = decisions.filter((d) => String(d.body.decision).includes("without a passing shot review")).length;
  const pictures = view.assets.filter((a) => a.kind === "image" && a.projectId === projectId && a.source === "generated" && a.meta?.purpose !== "canvas");
  const edits = pictures.filter((a) => a.meta?.purpose === "edit").length;
  const checked = pictures.filter((a) => (a.meta?.autoReview as { verdict?: string } | undefined)?.verdict);
  const failedCheck = checked.filter((a) => (a.meta.autoReview as { verdict?: string }).verdict === "fail").length;
  const noSpeed = done.filter((t) => Array.isArray(t.input.loras) && !(t.input.loras as Array<{ kind?: string }>).some((l) => l.kind === "speed") && t.workflow !== "REMAKE" && t.workflow !== "REGEN");
  const withSpeed = done.filter((t) => Array.isArray(t.input.loras) && (t.input.loras as Array<{ kind?: string }>).some((l) => l.kind === "speed"));
  const avg = (ts: typeof takes) => (ts.length ? ts.reduce((a, t) => a + (t.costUsd ?? 0), 0) / ts.length : 0);
  const open = requirements.filter((r) => r.status !== "met" && r.status !== "dropped").length;
  L.push("## How it was made", "");
  L.push(`- Shot reviews: ${reviewedShots} of ${rendered} rendered shot(s) had one (${independent(shotReviews)} of ${shotReviews.length} by a fresh reviewer)${skipped ? `; ${skipped} render(s) skipped the review on the record` : ""}.`);
  L.push(`- Story reviews: ${byStage("story").length} (${independent(byStage("story"))} independent). Film reviews: ${byStage("film").length} (${independent(byStage("film"))} independent). Frame reviews: ${byStage("frame").length} (${independent(byStage("frame"))} independent).`);
  if (pictures.length) L.push(`- Pictures drawn: ${pictures.length} for ${shotsAll.length} shot(s), ${edits} of them edits${checked.length ? `; the self-check failed ${failedCheck} of ${checked.length}` : ""}.`);
  if (noSpeed.length) L.push(`- ${noSpeed.length} take(s) rendered without a speed LoRA (base chain), ${avg(noSpeed).toFixed(3)} USD each${withSpeed.length ? ` against ${avg(withSpeed).toFixed(3)} USD with one` : ""}. If nobody chose that, check those shots' use-turbo switch on the Board.`);
  if (requirements.length) L.push(`- Requirements: ${open} of ${requirements.length} still open.`);
  L.push("");

  L.push("## Shot by shot", "", "| Shot | Takes | Rejected | Prompt revisions | Faults | Experiments | Review |", "|---|---|---|---|---|---|---|");
  for (const scene of view.scenes) for (const sh of scene.shots) {
    const ts = [...sh.takes].sort((a, b) => a.n - b.n);
    const revisions = new Set(ts.map(takeRenderHash)).size;
    const f = [...new Set(ts.flatMap((t) => t.review?.faults ?? []))].join(", ");
    const ex = [...new Set(ts.flatMap((t) => Object.entries((t.input.studio_experiments ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k)))].join(", ");
    const rv = reviews.find((r) => r.stage === "shot" && r.shotId === sh.id);
    L.push(`| ${scene.slug} #${sh.index + 1} | ${ts.length} | ${ts.filter(isRejected).length} | ${revisions} | ${f || "—"} | ${ex || "—"} | ${rv ? `${rv.verdict} (${rv.reviewer})` : "—"} |`);
  }
  L.push("");

  const fragile = view.scenes.flatMap((s) => s.shots.map((sh) => ({ label: `${s.slug} #${sh.index + 1}`, f: director.shotFragility(sh.spec as never), takes: sh.takes.length })));
  const hard = fragile.filter((x) => x.f.score > 0).sort((a, b) => b.takes - a.takes).slice(0, 8);
  if (hard.length) {
    L.push("## Fragile shots and what they cost", "");
    for (const h of hard) L.push(`- ${h.label}: ${h.takes} take(s); ${h.f.reasons.map((r) => r.code).join(", ")}`);
    L.push("");
  }

  const pair = takes.filter((t) => t.input.studio_experiments);
  if (pair.length) {
    L.push("## Prompt experiments", "", `${pair.length} take(s) rendered with an experiment on. Compare them with their siblings on the eval page before turning one on by default.`, "");
  }

  L.push("## Requirements", "");
  if (!requirements.length) L.push("None were recorded.");
  for (const r of requirements) L.push(`- [${r.status === "met" ? "x" : r.status === "dropped" ? "-" : " "}] ${String(r.body.text)}${r.body.note ? ` — ${String(r.body.note)}` : ""}`);
  L.push("", "## Decisions", "");
  if (!decisions.length) L.push("None were logged.");
  for (const d of decisions) L.push(`- ${new Date(d.createdAt).toISOString().slice(0, 16)} ${d.status === "overturned" ? "~~" : ""}${String(d.body.decision)}${d.status === "overturned" ? "~~ (overturned)" : ""} — ${String(d.body.why ?? "")}${d.body.confidence ? ` [${String(d.body.confidence)}]` : ""}`);
  L.push("", "## Carry forward", "");
  /* A fault and the take that got past it: what changed between the two is the lesson. */
  const fixes: string[] = [];
  const costly: string[] = [];
  for (const scene of view.scenes) for (const sh of scene.shots) {
    const label = `${scene.slug} #${sh.index + 1}`;
    const ts = [...sh.takes].sort((a, b) => a.n - b.n);
    const usd = ts.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    if (ts.length >= 3) costly.push(`- ${label}: ${ts.length} takes, ${usd.toFixed(2)} USD${director.shotFragility(sh.spec as never).reasons.length ? ` (fragile: ${director.shotFragility(sh.spec as never).reasons.map((r) => r.code).join(", ")})` : ""}`);
    const good = ts.find((t) => t.id === sh.selectedTakeId) ?? ts.find((t) => t.review && !isRejected(t));
    if (!good) continue;
    for (const bad of ts.filter((t) => t.n < good.n && (t.review?.faults?.length ?? 0) > 0)) {
      const changed = retakeChanges(bad, good).map((c) => (c === "mode" ? `${bad.workflow} → ${good.workflow}` : c === "steps" ? `${String(bad.input.steps)} → ${String(good.input.steps)} steps` : c === "length" ? `${String(bad.input.seconds)} → ${String(good.input.seconds)} s` : c === "seed" ? "the seed only" : c));
      const said = retakeRecord(good)?.change;
      fixes.push(`- ${label}: ${bad.review!.faults!.join(", ")} on take #${bad.n}${bad.review!.notes ? ` ("${bad.review!.notes.slice(0, 140)}")` : ""} → take #${good.n} held; changed: ${changed.join(", ")}${said ? ` — "${said.slice(0, 140)}"` : ""}`);
    }
  }
  if (fixes.length) L.push("What got past a fault (compare the two takes' prompts with get_take):", ...fixes, "");
  /* The same pairs counted: per fault, which change held and which brought the fault back. */
  const tally = fixTally(fixLedger(shotsAll));
  if (tally.length) {
    L.push("Which change got past which fault (a faulted take and the take after it; small counts are anecdotes, not rates):", "", "| Fault | Changed | Held | Came back | Unjudged |", "|---|---|---|---|---|");
    for (const r of tally) L.push(`| ${r.fault} | ${r.change} | ${r.held} | ${r.cameBack} | ${r.unjudged} |`);
    L.push("");
  }
  if (costly.length) L.push("Shots that took three takes or more — plan them differently at the story stage:", ...costly, "");
  const exNames = [...new Set(pair.flatMap((t) => Object.entries((t.input.studio_experiments ?? {}) as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k)))];
  for (const name of exNames) {
    const on = pair.filter((t) => (t.input.studio_experiments as Record<string, boolean>)[name]);
    L.push(`- Experiment ${name}: ${on.length} take(s), ${on.filter((t) => shotsAll.some((sh) => sh.selectedTakeId === t.id)).length} picked, ${on.filter(isRejected).length} rejected.`);
  }
  if (!fixes.length && !tally.length && !costly.length && !exNames.length) L.push("Nothing to carry yet: no reviewed take followed a faulted one, no shot took three takes, no experiment ran. Review the takes (review_take with faults) so the next film has something to learn from.");
  L.push("");
  return L.join("\n");
}
