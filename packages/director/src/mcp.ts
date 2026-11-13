#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStyles, findStyle, suggestStyles } from "./styles/index.js";
import { styleToMarkdown } from "./styles/markdown.js";
import { compileLook, applyStyle, styleLoraSuggestions } from "./compile/look.js";
import { validateTreatment, treatmentToMarkdown } from "./treatment.js";
import { lintShotlist } from "./lint/shotlist.js";
import { checkCueMap, cutOnBeats, hitTimes, type CueMap } from "./sound/cuemap.js";
import { checkTimeline, toStudioTimeline, type ExtTimeline } from "./timeline/extended.js";
import { assemble } from "./timeline/assemble.js";
import { checkLines, placeLines, toSrt, spellNumbersForSpeech, type Line } from "./narration/srt.js";
import { synthesize } from "./narration/tts.js";
import { planBatch, type BatchShot } from "./batch.js";
import { faultRoutes } from "./faults.js";
import { AB_TESTS, planAb } from "./ab.js";
import { splitShot } from "./split.js";
import { carriedStates, stateText } from "./state.js";
import { flatShots, type Shotlist } from "./types.js";

/**
 * The director MCP: judgement helpers that sit beside the Kinora Studio MCP.
 * Nothing here spends money or talks to the Studio; every output is a payload
 * for a Studio tool (`start_film`, `update_look`, `save_shotlist`, `save_script`,
 * `save_timeline`, `generate_take`) or a local file.
 */
const server = new McpServer({ name: "director", version: "0.1.0" }, {
  instructions: "Director layer for Kinora Studio. Read get_guide('director') first. Flow: suggest_styles/get_style → compile_look (→ start_film) → validate_treatment (→ save_script with its markdown) → apply_style + lint_shotlist (→ save_shotlist) → build_cue_map/check_cue_map → plan_batch (→ generate_take; after a take: fix_for_faults; to test a default: plan_ab) → check_timeline/to_studio_timeline (→ save_timeline) → assemble_local for J/L cuts, titles, narration.",
});

const text = (x: unknown) => ({ content: [{ type: "text" as const, text: typeof x === "string" ? x : JSON.stringify(x, null, 2) }] });
const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

server.registerTool("get_guide", {
  description: "The director guides: 'director' (judgement: brief, treatment, story, sound, rhythm, camera, delivery), 'technique' (the H3 constraints: modes, links, frame grid, base models, what the assembler can do), 'styles' (the style index).",
  inputSchema: { section: z.enum(["director", "technique", "styles"]).default("director") },
}, async ({ section }) => {
  const file = section === "styles" ? join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "README.md") : join(docsDir, section === "director" ? "DIRECTOR.md" : "TECHNIQUE-H3.md");
  return text(existsSync(file) ? readFileSync(file, "utf8") : `missing ${file}`);
});

server.registerTool("list_styles", {
  description: "Every style preset (user styles first, then the library): slug, names, category, uses, one line.",
  inputSchema: {},
}, async () => text(loadStyles().map(({ style: s, origin }) => ({ slug: s.slug, en: s.en, cn: s.cn, category: s.category, uses: s.uses, line: s.line, line_cn: s.line_cn, origin }))));

server.registerTool("suggest_styles", {
  description: "Two or three styles that fit a topic, with why. Then ask the user to pick by name.",
  inputSchema: { topic: z.string().min(2), n: z.number().int().min(1).max(5).default(3) },
}, async ({ topic, n }) => text(suggestStyles(topic, n).map((r) => ({ slug: r.style.slug, en: r.style.en, cn: r.style.cn, score: r.score, why: r.why, line: r.style.line }))));

server.registerTool("get_style", {
  description: "One style preset in full: as JSON (the compiled engine fields, camera grammar, native moves, pitfalls, variation space) or as STYLE.md.",
  inputSchema: { style: z.string().min(1).describe("slug, English or Chinese name"), format: z.enum(["json", "markdown"]).default("markdown") },
}, async ({ style, format }) => {
  const s = findStyle(style);
  if (!s) return text({ error: `no style matches "${style}"`, available: loadStyles().map((x) => x.style.slug) });
  return text(format === "json" ? s.style : styleToMarkdown(s.style));
});

server.registerTool("compile_look", {
  description: "Style → the `look` object for start_film / update_look (genre, palette, camera, lens, lighting, constraints). LoRAs are not in the look: they are per shot; the style's LoRA suggestions come back beside it, for assign_loras once the board is designed.",
  inputSchema: {
    style: z.string().min(1),
    aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    negative: z.array(z.string().max(80)).optional().describe("extra constraints from the brief, each a statement of what the picture shows (H3 has no negative prompt)"),
    genreSuffix: z.string().max(80).optional(),
    paletteSuffix: z.string().max(80).optional(),
  },
}, async ({ style, ...o }) => {
  const s = findStyle(style);
  if (!s) return text({ error: `no style matches "${style}"` });
  return text({ look: compileLook(s.style, o), beatSuffix: s.style.engine.beatSuffix, cinematographyDefaults: s.style.engine.cinematography, allowedCameraMoves: s.style.camera.grammar.map((g) => g.move), transitions: s.style.camera.transitions, durationGuide: s.style.engine.durations, ...(styleLoraSuggestions(s.style).length ? { loraSuggestions: { note: "Not in the look: LoRAs are per shot. Once the board is designed, give the shots each suits that LoRA with assign_loras, each with why (the size or motion the suggestion names); the user sees them on the shot and can switch them off.", loras: styleLoraSuggestions(s.style) } } : {}) });
});

const ShotlistSchema = z.object({ scenes: z.array(z.object({ slug: z.string(), summary: z.string().optional(), location: z.string().optional(), shots: z.array(z.any()) })) });

server.registerTool("apply_style", {
  description: "Fill every shot's cinematography with the style defaults (explicit values win), append the style's beat suffix, default ambience/music, and warn about camera moves and links outside the style's grammar. Returns the shotlist to pass to save_shotlist.",
  inputSchema: { style: z.string().min(1), shotlist: ShotlistSchema, beatSuffix: z.boolean().default(true), musicForShotsWithScore: z.boolean().default(true) },
}, async ({ style, shotlist, beatSuffix, musicForShotsWithScore }) => {
  const s = findStyle(style);
  if (!s) return text({ error: `no style matches "${style}"` });
  return text(applyStyle(s.style, shotlist as any, { beatSuffix, musicForShotsWithScore }));
});

server.registerTool("lint_shotlist", {
  description: "Deterministic rhythm, craft and continuity lint on a shotlist in save_shotlist shape: pace and framing variety, a breath, static use, runs of the same link, dialogue density, beats tiling, link/mode sanity, render-order switches; staging (blocking in screen terms, the 180° line, what moves, dead frames), wording the model misreads (loose directions, negations, unison reactions) the pictures video models get wrong (fragile.*), and the state each element carries from shot to shot (state.*: a reference-mode shot that would draw the sheet's look, an insert_return over a change, a change nobody recorded). Pass elements so names in the beats are checked against each shot. Run before save_shotlist and fix the errors and warnings.",
  inputSchema: { shotlist: ShotlistSchema, totalSeconds: z.number().int().optional(), errorsAndWarningsOnly: z.boolean().default(false), elements: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(["character", "location", "prop"]), fixedFeatures: z.array(z.object({ feature: z.string(), where: z.string() })).optional() })).optional() },
}, async ({ shotlist, totalSeconds, errorsAndWarningsOnly, elements }) => text(lintShotlist(shotlist as any, { totalSeconds, errorsAndWarningsOnly, elements })));

server.registerTool("validate_treatment", {
  description: "Check a treatment (logline, arc, three candidate structures and the chosen one, benchmark learn/don't, hook ≤ 3 s, ending echo, signature shot, native move, sequences with pace, sound design table, silences, J/L cuts). Returns warnings and TREATMENT.md to put in save_script.",
  inputSchema: { treatment: z.any(), style: z.string().optional() },
}, async ({ treatment, style }) => {
  const s = style ? findStyle(style) : undefined;
  const r = validateTreatment(treatment, s?.style.nativeMoves.map((m) => m.name));
  return text({ ...r, markdown: r.ok ? treatmentToMarkdown(treatment) : undefined });
});

const CueMapSchema = z.object({
  sections: z.array(z.object({ id: z.string(), t: z.number().min(0), bpm: z.number(), beatsPerBar: z.number().int().optional(), texture: z.string().optional() })).min(1),
  hits: z.array(z.object({ id: z.string(), section: z.string(), bar: z.number(), beat: z.number(), what: z.string() })).default([]),
  silences: z.array(z.object({ t: z.number(), durationS: z.number(), why: z.string() })).optional(),
});

server.registerTool("check_cue_map", {
  description: "Validate a cue map (tempo sections, hit points as section/bar/beat, silences) and resolve every hit to seconds; with a shotlist, warn when hits land at shot seams.",
  inputSchema: { cueMap: CueMapSchema, shotlist: ShotlistSchema.optional(), totalSeconds: z.number().optional() },
}, async ({ cueMap, shotlist, totalSeconds }) => text({ warnings: checkCueMap(cueMap as CueMap, shotlist as any, totalSeconds), hits: hitTimes(cueMap as CueMap) }));

server.registerTool("cut_on_beats", {
  description: "Given a cue map and the shots in order, compute per-clip outS so every cut lands on the grid (subdivision 1 = beat, 0.25 = bar in 4/4, 2 = half beat) within each take's renderable length.",
  inputSchema: { cueMap: CueMapSchema, shots: z.array(z.object({ durationS: z.number() })), subdivision: z.number().default(1), startS: z.number().default(0) },
}, async ({ cueMap, shots, subdivision, startS }) => text(cutOnBeats(cueMap as CueMap, shots, { subdivision, startS })));

server.registerTool("check_subtitles", {
  description: "Reading-time check for subtitle/narration lines (CJK ÷ 4.5 + Latin ÷ 15 + 1.5 s, ≥ 1.8 s, ≥ speech + 0.6 s). Places unplaced lines in order. Returns issues, placed lines and the SRT.",
  inputSchema: { lines: z.array(z.object({ id: z.string(), text: z.string(), t0: z.number().optional(), t1: z.number().optional(), language: z.string().optional(), speechS: z.number().optional() })), startS: z.number().default(0), gapS: z.number().default(0.3) },
}, async ({ lines, startS, gapS }) => {
  const placed = placeLines(lines as Line[], startS, gapS);
  return text({ issues: checkLines(placed), lines: placed, srt: toSrt(placed), speech: placed.map((l) => ({ id: l.id, say: spellNumbersForSpeech(l.text) })) });
});

server.registerTool("synthesize_narration", {
  description: "Render narration lines to audio files with edge-tts (Microsoft neural voices; needs `pip install edge-tts` and network) or macOS `say`. Returns files and measured durations for the timeline's narration track.",
  inputSchema: { lines: z.array(z.object({ id: z.string(), text: z.string() })), outDir: z.string(), engine: z.enum(["edge-tts", "say"]).default("edge-tts"), voice: z.string().optional(), rate: z.string().optional() },
}, async ({ lines, outDir, engine, voice, rate }) => {
  try { return text(await synthesize(lines as Line[], { outDir, engine, voice, rate })); } catch (e) { return text({ error: (e as Error).message }); }
});

server.registerTool("plan_batch", {
  description: "Order takes to render: R2VA shots first, then the fl2va family; linked shots after their anchors (passes); one total estimate against the budget cap so a single confirmation covers the batch. Pass each shot's estimateUsd from compile_prompt; without it the estimate is the per-second average times the shot's rendered length, and the plan says which shots that is.",
  inputSchema: {
    shots: z.array(z.object({ shotId: z.string(), index: z.number().int(), durationS: z.number(), mode: z.enum(["text", "keyframe", "reference", "edit"]), link: z.object({ type: z.string(), anchor: z.number().optional(), anchorShotId: z.string().optional() }).optional(), hasTake: z.boolean().optional(), estimateUsd: z.number().optional() })),
    capUsd: z.number(), spentUsd: z.number().default(0), perSecondUsd: z.number().optional(), takesPerShot: z.number().int().min(1).max(4).default(1), onlyMissing: z.boolean().default(true),
  },
}, async ({ shots, capUsd, spentUsd, perSecondUsd, takesPerShot, onlyMissing }) => text(planBatch(shots as BatchShot[], { capUsd, spentUsd }, { perSecondUsd, takesPerShot, onlyMissing })));

server.registerTool("fix_for_faults", {
  description: "From the faults tagged on a take to the fix each calls for, cheapest first: a picture fault (identity, a lost prop, a count) goes to a painted frame, another mode or Viggle Remake and not to new wording; a motion fault (the action, its timing, the camera) to the shot's beats, length or camera and a new render, which Remake cannot fix; a head or tail fault to the edit; a sound fault to the timeline. The Studio's review_take answers with the same table.",
  inputSchema: { faults: z.array(z.string().min(1).max(40)).min(1).max(8).describe("Fault tags as review_take takes them: identity_drift, wardrobe_or_prop_lost, action_timing, tail_snap, audio_bad …") },
}, async ({ faults }) => text(faultRoutes(faults)));

server.registerTool("carried_state", {
  description: "What every character, prop and place carries into and out of each shot of a shotlist, from the shots' state records (what they wear now, hold, are like, where that differs from the sheet). A state holds until another record changes it. Use it to see what a later shot's prompt and frames will be told; lint_shotlist names the shots that cannot show it (state.reference, state.resume).",
  inputSchema: { shotlist: ShotlistSchema },
}, async ({ shotlist }) => {
  const shots = flatShots(shotlist as Shotlist);
  const states = carriedStates(shots.map((s) => s.shot));
  const say = (r: Record<string, { wardrobe?: string; holding?: string; condition?: string }>) => Object.fromEntries(Object.entries(r).map(([who, s]) => [who, stateText(s)]));
  return text(shots.map((s, i) => ({ scene: s.scene.slug, shot: s.index, atStart: say(states[i]!.before), atEnd: say(states[i]!.after) })));
});

server.registerTool("plan_ab", {
  description: "Lay out an A/B test on one shot (a shot object as save_shotlist takes it), spending nothing: format (the Studio's default prompt serialisation against MiniMax's published format, experiments.officialFormat), restate_frame (trust the first frame, or restate it as MiniMax's guide asks), steps (8-step turbo against the base chain at 20 steps, on prompt following). Returns the question, the two arms, the seeds, what is held the same, what to read on the takes and what the answer will not show. The Studio's plan_ab does the same on a saved shot and adds the cost and the calls. Shot length is not a test: long action is two chained shots (split_shot), the user's decision.",
  inputSchema: { test: z.enum(AB_TESTS), shot: z.any(), seeds: z.array(z.number().int().min(0)).min(1).max(4).optional() },
}, async ({ test, shot, seeds }) => {
  try { return text(planAb(test, shot, { seeds })); } catch (e) { return text({ error: (e as Error).message }); }
});

server.registerTool("split_shot", {
  description: "The project's rule for long action: two shots, not one long generation (the user's choice, 6 + 6 over one 12 s shot; lint_shotlist warns with duration.complex). This divides one shot into two, the second continuing from the first's last frame (link continuous): the beats, timed lines, frames and state are divided at a beat boundary on a whole second with 5 s or more on both sides (the one nearest the middle, or atS). Nothing is rewritten. Put the two in the shotlist in place of the long shot.",
  inputSchema: { shot: z.any(), atS: z.number().optional() },
}, async ({ shot, atS }) => {
  try { return text(splitShot(shot, atS)); } catch (e) { return text({ error: (e as Error).message }); }
});

const ExtTimelineSchema = z.any();

server.registerTool("check_timeline", {
  description: "Validate a timeline in the director's own shape (clips with J/L cuts, transitions, freezes; titles; narration; music; silences): too-short cards, a J-cut the take has no footage for, too few sound bridges or silences. Returns the timeline as the Studio's save_timeline takes it (it draws and mixes nearly all of this now) and what could not go along.",
  inputSchema: { timeline: ExtTimelineSchema },
}, async ({ timeline }) => text({ warnings: checkTimeline(timeline as ExtTimeline), ...toStudioTimeline(timeline as ExtTimeline) }));

server.registerTool("assemble_local", {
  description: "Assemble the extended timeline with ffmpeg from downloaded take files: dissolves, fades, iris, wipes, J/L cuts, freezes, title cards and captions, narration, music with ducking, silences, burned subtitles, loudnorm −14 LUFS. dryRun returns the command.",
  inputSchema: { timeline: ExtTimelineSchema, out: z.string(), dryRun: z.boolean().default(false), fontFile: z.string().optional() },
}, async ({ timeline, out, dryRun, fontFile }) => {
  try { return text(await assemble(timeline as ExtTimeline, { out, dryRun, fontFile })); } catch (e) { return text({ error: (e as Error).message }); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
